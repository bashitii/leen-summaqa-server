// DEVELOPMENT-ONLY FAKE GATEWAY. It exists so the whole order flow can be tested end to end without a bank.
// It never sees card data, it is refused when NODE_ENV=production (see config.ts), and its confirm route
// (routes/payments.ts) is only mounted when this provider is active. Nothing here may be copied into the real adapter.
import type { Request } from 'express';
import { randomUUID } from 'crypto';
import { env } from '../config';
import { db } from '../supabase';
import { CallbackResult, NotConfiguredError, PaymentProvider, PaymentRequest, Verified } from './types';

export class MockProvider implements PaymentProvider {
  readonly name = 'mock';
  async createPayment(o: PaymentRequest) {
    const providerRef = `MOCK-${randomUUID()}`;
    // The "bank page" is a dev-only screen in our own client with two buttons: succeed / fail.
    return { providerRef, redirectUrl: `${env.CLIENT_URL}/dev/mock-pay?ref=${providerRef}&order=${o.orderNumber}&amount=${o.amount}&currency=${o.currency}&return=${encodeURIComponent(o.returnUrl)}` };
  }
  async verifyPayment(ref: string): Promise<Verified> {
    const { data } = await db.from('payments').select('status,amount,currency').eq('provider', 'mock').eq('provider_ref', ref).maybeSingle();
    return { status: (data?.status === 'PAID' ? 'PAID' : data?.status === 'FAILED' ? 'FAILED' : 'PENDING') as 'PAID' | 'FAILED' | 'PENDING', amount: Number(data?.amount ?? 0), currency: data?.currency ?? '' };
  }
  expectedAmount(o: { total: number; fxRate: number }) { return o.total; }
  async handleCallback(_req: Request): Promise<CallbackResult> { throw new NotConfiguredError('The mock callback (use POST /api/payments/mock/confirm)'); }
  async refundPayment(_ref: string, _amount: number) { /* pretend the bank accepted the refund */ }
}
