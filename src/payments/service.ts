// PAYMENT RULES (gateway-independent). Three guarantees:
//  1. An order becomes PAID only through applyPaymentResult(), never because a browser reached a "success" page.
//  2. Callbacks are IDEMPOTENT: every event is recorded once (unique provider+event id); a repeat does nothing.
//  3. A "failed" signal can never undo a payment that already succeeded.
import { db } from '../supabase';
import { env } from '../config';
import { HttpError } from '../middleware/error';
import { getProvider } from './index';
import { notifyOrderPaid } from '../email/notify';
import type { PayAddress } from './types';

// HyperPay wants first/last name and a full billing address. We use the billing address, or the shipping address when none was given.
function payAddress(o: any): PayAddress {
  const a = o.billing_address ?? o.shipping_address ?? {};
  const parts = String(a.recipient ?? '').trim().split(/\s+/).filter(Boolean);
  const givenName = parts[0] ?? 'Customer';
  return { givenName, surname: parts.slice(1).join(' ') || givenName,
    street: [a.line1, a.line2].filter(Boolean).join(', ') || '-', city: a.city || '-', state: a.region || a.city || '-',
    postcode: a.postal_code || '00000', country: String(a.country_code ?? 'JO').toUpperCase() };
}

// Begin (or retry) paying for an order. Returns the URL to send the customer to.
export async function startPayment(orderId: string): Promise<string> {
  const { data: o } = await db.from('orders').select('id,order_number,total,currency,fx_rate,email,status,payment_status,public_token,shipping_address,billing_address').eq('id', orderId).maybeSingle();
  if (!o) throw new HttpError(404, 'Order not found');
  if (o.status === 'CANCELLED') throw new HttpError(409, 'This order was cancelled. Please place a new order');
  if (o.payment_status === 'PAID') throw new HttpError(409, 'This order is already paid');
  const provider = getProvider();
  const jodAmount = Math.round((Number(o.total) / Number(o.fx_rate || 1)) * 1000) / 1000;      // JOD equivalent (orders store total in their own currency)
  const p = await provider.createPayment({ orderId: o.id, orderNumber: o.order_number, amount: Number(o.total), currency: o.currency, jodAmount, email: o.email,
    returnUrl: `${env.CLIENT_URL}/checkout/complete?order=${o.id}&token=${o.public_token}`, address: payAddress(o) });
  const { error } = await db.from('payments').insert({ order_id: o.id, provider: provider.name, provider_ref: p.providerRef, status: 'PENDING', amount: o.total, currency: o.currency });
  if (error) throw error;
  return p.redirectUrl;
}

// Ask the gateway what happened to ONE payment attempt and apply it. Used when the customer returns AND by the 5-minute reconcile job.
// Returns 'PAID' | 'FAILED' | 'PENDING' (the real state at the gateway).
export async function confirmPayment(orderId: string, providerRef: string): Promise<'PAID' | 'FAILED' | 'PENDING'> {
  const provider = getProvider();
  const { data: pay } = await db.from('payments').select('id').eq('order_id', orderId).eq('provider', provider.name).eq('provider_ref', providerRef).maybeSingle();
  if (!pay) throw new HttpError(404, 'Unknown payment');
  const { data: o } = await db.from('orders').select('total,fx_rate').eq('id', orderId).single();
  const v = await provider.verifyPayment(providerRef);
  if (v.status === 'PENDING') return 'PENDING';
  if (v.merchantTransactionId && v.merchantTransactionId !== orderId) throw new HttpError(400, 'Payment does not belong to this order');
  if (v.status === 'PAID') {
    const expected = provider.expectedAmount({ total: Number(o!.total), fxRate: Number(o!.fx_rate || 1) });
    if (Math.abs(v.amount - expected) > 0.0005) {                    // paid less (or more) than the order needs: never mark it paid
      console.error('[payments] AMOUNT MISMATCH order', orderId, 'gateway', v.amount, v.currency, 'expected', expected);
      throw new HttpError(409, 'The paid amount does not match the order. Please contact us');
    }
  }
  await db.from('payments').update({ raw_response: v.raw ?? null }).eq('id', pay.id);          // keep the gateway's full answer on the payment row (audit)
  // The order's own total is what mark_order_paid compares against (it is in the order currency); the gateway amount was checked above.
  await applyPaymentResult({ provider: provider.name, eventId: `${providerRef}:${v.status}`, providerRef, orderId, amount: Number(o!.total), status: v.status, payload: v.raw });
  return v.status;
}

export type Outcome = 'applied' | 'duplicate' | 'ignored';
export async function applyPaymentResult(r: { provider: string; eventId: string; providerRef: string; orderId: string; amount: number; status: 'PAID' | 'FAILED'; payload?: unknown }): Promise<Outcome> {
  // Record the event FIRST. If it already exists, this is a repeat delivery: do nothing.
  const { error: dup } = await db.from('payment_events').insert({ provider: r.provider, event_id: r.eventId, payload: r.payload ?? null });
  if (dup) { if (dup.code === '23505') return 'duplicate'; throw dup; }
  try {
    if (r.status === 'PAID') {
      const { data: firstTime, error } = await db.rpc('mark_order_paid', { p_order_id: r.orderId, p_provider: r.provider, p_provider_ref: r.providerRef, p_amount: r.amount });
      if (error) throw error;                                      // AMOUNT_MISMATCH etc: never marks paid
      if (firstTime) void notifyOrderPaid(r.orderId);              // the RPC says true only once per order -> exactly one set of emails
      return 'applied';
    }
    const { data: o } = await db.from('orders').select('payment_status').eq('id', r.orderId).single();
    if (o?.payment_status === 'PAID') return 'ignored';              // rule 3
    await db.from('payments').update({ status: 'FAILED' }).eq('provider', r.provider).eq('provider_ref', r.providerRef);
    await db.from('orders').update({ payment_status: 'FAILED' }).eq('id', r.orderId);
    await db.rpc('cancel_order', { p_order_id: r.orderId });          // failed payment: release the reserved stock
    return 'applied';
  } catch (e) {
    await db.from('payment_events').delete().eq('provider', r.provider).eq('event_id', r.eventId);   // let the gateway's redelivery be retried
    throw e;
  }
}

// Unpaid orders must not hold stock forever: cancel (and release stock for) orders still unpaid after the TTL.
export async function expireUnpaidOrders(minutes = env.UNPAID_ORDER_TTL_MINUTES) {
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
  const { data } = await db.from('orders').select('id').eq('status', 'PENDING').eq('payment_status', 'PENDING').lt('created_at', cutoff).limit(100);
  let expired = 0;
  for (const o of data ?? []) {
    // Before cancelling, ask the gateway: the customer may have paid and closed the tab. If so, mark it paid instead of cancelling.
    if (getProvider().name !== 'mock' && (await reconcileOrder(o.id))) continue;
    expired++;
    await db.from('orders').update({ payment_status: 'FAILED' }).eq('id', o.id).eq('payment_status', 'PENDING');
    await db.rpc('cancel_order', { p_order_id: o.id });
  }
  return expired;
}

// True when any payment attempt of this order turned out PAID at the gateway (and has now been applied).
async function reconcileOrder(orderId: string): Promise<boolean> {
  const { data: pays } = await db.from('payments').select('provider_ref').eq('order_id', orderId).eq('provider', getProvider().name).eq('status', 'PENDING');
  for (const p of pays ?? []) {
    try { if ((await confirmPayment(orderId, p.provider_ref)) === 'PAID') return true; } catch (e) { console.error('[payments] reconcile failed', orderId, (e as Error).message); }
  }
  return false;
}

export async function refundOrder(orderId: string) {
  const { data: pay } = await db.from('payments').select('*').eq('order_id', orderId).eq('status', 'PAID').maybeSingle();
  if (!pay) throw new HttpError(409, 'There is no paid payment to refund');
  const provider = getProvider();
  if (pay.provider !== provider.name) throw new HttpError(409, `This payment was made through "${pay.provider}", which is not the active gateway`);
  await provider.refundPayment(pay.provider_ref, Number(pay.amount));
  await db.from('payments').update({ status: 'REFUNDED' }).eq('id', pay.id);
  await db.from('orders').update({ payment_status: 'REFUNDED' }).eq('id', orderId);
}
