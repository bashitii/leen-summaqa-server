// HYPERPAY ADAPTER — the "COPYandPAY" flow (docs: https://hyperpay.docs.oppwa.com/integrations/widget).
//
//   1. createPayment : our server POSTs "prepare checkout" to HyperPay -> gets a checkout id.
//                      The customer is sent to OUR page /checkout/pay, which loads HyperPay's card form for that id.
//                      Card numbers go straight from the browser to HyperPay: our server and database never see them.
//   2. return        : after the card (and 3-D Secure) HyperPay sends the customer to /checkout/complete?id=<checkout id>.
//   3. verifyPayment : our server asks HyperPay (GET /v1/checkouts/{id}/payment) what REALLY happened and reads the result code.
//                      Only this server-to-server answer can mark an order PAID, never the browser reaching a page.
//   4. refundPayment : "RF" request on the original payment id.
//
// MONEY RULE: this HyperPay account charges JOD only. Orders in USD/EUR/AED/SAR are charged their JOD equivalent
// (order total / fx_rate); the checkout page tells the customer so. The amount HyperPay reports is compared with that
// expected JOD amount before an order is marked paid.
//
// NOT IMPLEMENTED ON PURPOSE: the encrypted webhook (HYPERPAY_WEBHOOK_KEY). Verification on return + the 5-minute
// reconcile job in service.ts already cover a customer who closes the tab after paying.
import type { Request } from 'express';
import { env } from '../config';
import { db } from '../supabase';
import { HttpError } from '../middleware/error';
import { CallbackResult, NotConfiguredError, PaymentProvider, PaymentRequest, Verified } from './types';

// HyperPay result codes (https://hyperpay.docs.oppwa.com/reference/resultCodes): which families mean paid / still pending.
const SUCCESS = /^(000\.000\.|000\.100\.1|000\.[36]|000\.400\.[1][12]0)/;
const PENDING = /^(000\.200|800\.400\.5|100\.400\.500)/;
const NO_PAYMENT_YET = /^200\.300\.404/;     // "checkout exists but no payment was submitted on it"

// The amount string HyperPay receives AND the number we expect back. One function so both sides can never disagree.
// Test server: whole numbers only (xx.00). Live: env.HYPERPAY_AMOUNT_DECIMALS decimals.
export function chargeAmount(jod: number): number {
  if (env.HYPERPAY_TEST_MODE) return Math.max(1, Math.round(jod));
  const f = 10 ** env.HYPERPAY_AMOUNT_DECIMALS;
  return Math.round(jod * f) / f;
}
const fmt = (n: number) => n.toFixed(env.HYPERPAY_TEST_MODE ? 2 : Math.max(2, env.HYPERPAY_AMOUNT_DECIMALS));

const base = () => (env.HYPERPAY_BASE_URL ?? '').replace(/\/+$/, '');
const auth = () => ({ Authorization: `Bearer ${env.HYPERPAY_ACCESS_TOKEN}` });

async function call(method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<any> {
  try {
    const res = await fetch(base() + path, {
      method, headers: { ...auth(), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined, signal: AbortSignal.timeout(20_000),
    });
    return await res.json();                       // HyperPay answers JSON even for errors (the result.code says what went wrong)
  } catch (e) {
    console.error('[hyperpay] request failed', method, path, (e as Error).message);
    throw new HttpError(502, 'The payment service is not reachable right now. Please try again in a moment');
  }
}

export class HyperPayProvider implements PaymentProvider {
  readonly name = 'hyperpay';

  expectedAmount(o: { total: number; fxRate: number }) { return chargeAmount(o.total / (o.fxRate || 1)); }

  async createPayment(o: PaymentRequest) {
    const form: Record<string, string> = {
      entityId: env.HYPERPAY_ENTITY_ID!, amount: fmt(chargeAmount(o.jodAmount)), currency: 'JOD', paymentType: 'DB',
      merchantTransactionId: o.orderId,            // our unique id; verified again when the payment comes back
      integrity: 'true',                           // HyperPay asks for this: the answer holds a hash (SRI) the browser uses to check the card-form script was not tampered with
      'customer.email': o.email, 'customer.givenName': o.address.givenName, 'customer.surname': o.address.surname,
      'billing.street1': o.address.street, 'billing.city': o.address.city, 'billing.state': o.address.state,
      'billing.country': o.address.country, 'billing.postcode': o.address.postcode,
    };
    if (env.HYPERPAY_TEST_MODE) { form.testMode = 'EXTERNAL'; form['customParameters[3DS2_enrolled]'] = 'true'; }   // test server only
    const r = await call('POST', '/v1/checkouts', form);
    if (!r?.id || !/^(000\.200|000\.000)/.test(r?.result?.code ?? '')) {
      console.error('[hyperpay] prepare checkout refused:', r?.result?.code, r?.result?.description, JSON.stringify(r?.result?.parameterErrors ?? []));
      throw new HttpError(502, 'Could not start the card payment. Please try again or contact us');
    }
    if (!r.integrity) console.warn('[hyperpay] prepare checkout returned no integrity value; the card form will load without the integrity check');
    const q = new URLSearchParams({ checkout: r.id, order: o.orderId, widget: base(), charge: fmt(chargeAmount(o.jodAmount)), return: o.returnUrl });
    if (r.integrity) q.set('integrity', String(r.integrity));   // the card page puts it on the HyperPay <script> tag
    return { providerRef: String(r.id), redirectUrl: `${env.CLIENT_URL}/checkout/pay?${q}` };
  }

  async verifyPayment(ref: string): Promise<Verified> {
    const r = await call('GET', `/v1/checkouts/${encodeURIComponent(ref)}/payment?entityId=${encodeURIComponent(env.HYPERPAY_ENTITY_ID!)}`);
    const code: string = r?.result?.code ?? '';
    const status: Verified['status'] = SUCCESS.test(code) ? 'PAID' : (PENDING.test(code) || NO_PAYMENT_YET.test(code)) ? 'PENDING' : 'FAILED';
    // The FULL answer is kept for audit and for HyperPay support. HyperPay already masks card details in it (bin, last 4 digits, masked holder),
    // and never returns the card number or CVV, so it is safe to store.
    const raw = r;
    return { status, amount: Number(r?.amount ?? 0), currency: String(r?.currency ?? ''), paymentId: r?.id, merchantTransactionId: r?.merchantTransactionId, raw };
  }

  // Webhook intentionally not offered (see header note).
  async handleCallback(_req: Request): Promise<CallbackResult> { throw new NotConfiguredError('The HyperPay webhook'); }

  // Always a FULL refund of what HyperPay captured. The payment id + JOD amount were saved when the payment was confirmed
  // (payment_events). We use that first because HyperPay only answers "checkout status" for a short time after the payment
  // (about 30 minutes), so asking again later would wrongly say "no payment".
  async refundPayment(ref: string, _orderAmount: number): Promise<void> {
    const { data: ev } = await db.from('payment_events').select('payload').eq('provider', 'hyperpay').eq('event_id', `${ref}:PAID`).maybeSingle();
    const saved: any = ev?.payload;
    let id: string | undefined = saved?.id, amount = Number(saved?.amount), currency: string = saved?.currency;
    if (!id || !amount) {                                            // older payment without saved details: ask HyperPay
      const v = await this.verifyPayment(ref);
      if (v.status !== 'PAID' || !v.paymentId) throw new HttpError(409, 'HyperPay has no completed payment to refund. Refund it in the HyperPay dashboard');
      id = v.paymentId; amount = v.amount; currency = v.currency;
    }
    const form: Record<string, string> = { entityId: env.HYPERPAY_ENTITY_ID!, amount: fmt(amount), currency, paymentType: 'RF' };
    if (env.HYPERPAY_TEST_MODE) form.testMode = 'EXTERNAL';           // the refund must use the same mode as the original payment (else 700.100.600)
    const r = await call('POST', `/v1/payments/${encodeURIComponent(id)}`, form);
    if (!SUCCESS.test(r?.result?.code ?? '')) {
      console.error('[hyperpay] refund refused:', r?.result?.code, r?.result?.description, '| sent testMode =', form.testMode ?? 'none');
      throw new HttpError(502, `HyperPay did not accept the refund (${r?.result?.code ?? 'no answer'}: ${r?.result?.description ?? ''}). You can refund it in the HyperPay dashboard`);
    }
  }
}
