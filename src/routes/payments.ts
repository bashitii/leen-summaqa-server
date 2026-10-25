import { Router } from 'express';
import { z } from 'zod';
import { db } from '../supabase';
import { env } from '../config';
import { optionalAuth } from '../middleware/auth';
import { asyncHandler, HttpError, validate } from '../middleware/error';
import { getProvider } from '../payments';
import { applyPaymentResult, confirmPayment, startPayment } from '../payments/service';

export const paymentsRouter = Router();

// Same access rule as viewing the order: its owner, or the secret link token.
async function assertOrderAccess(req: any, orderId: string) {
  const { data: o } = await db.from('orders').select('user_id,public_token').eq('id', orderId).maybeSingle();
  const ok = !!o && ((!!req.user && o.user_id === req.user.id) || (!!req.body.token && req.body.token === o.public_token));
  if (!ok) throw new HttpError(404, 'Order not found');
}
const accessIn = { order_id: z.string().uuid(), token: z.string().uuid().optional() };

// Customer wants to pay (or retry paying) for an order.
paymentsRouter.post('/start', optionalAuth, validate(z.object(accessIn)), asyncHandler(async (req, res) => {
  await assertOrderAccess(req, req.body.order_id);
  res.json({ redirect_url: await startPayment(req.body.order_id) });
}));

// The customer came back from the card page. The browser only tells us WHICH payment attempt; the server asks the gateway what happened.
paymentsRouter.post('/confirm', optionalAuth, validate(z.object({ ...accessIn, checkout_id: z.string().min(8).max(80) })), asyncHandler(async (req, res) => {
  if (getProvider().name === 'mock') throw new HttpError(404, 'Not available');
  await assertOrderAccess(req, req.body.order_id);
  res.json({ status: await confirmPayment(req.body.order_id, req.body.checkout_id) });
}));

// The bank's server-to-server callback. The provider authenticates it; then we VERIFY with the bank again before trusting a "paid".
// (When the real adapter is written, check whether the bank needs the raw request body to verify its signature.)
paymentsRouter.post('/callback', asyncHandler(async (req, res) => {
  const provider = getProvider();
  const cb = await provider.handleCallback(req);
  const { data: pay } = await db.from('payments').select('order_id').eq('provider', provider.name).eq('provider_ref', cb.providerRef).maybeSingle();
  if (!pay) throw new HttpError(404, 'Unknown payment');
  if (cb.status === 'PAID') {
    const v = await provider.verifyPayment(cb.providerRef);
    if (v.status !== 'PAID' || v.amount !== cb.amount) throw new HttpError(400, 'Payment could not be verified');
  }
  res.json({ result: await applyPaymentResult({ provider: provider.name, eventId: cb.eventId, providerRef: cb.providerRef, orderId: pay.order_id, amount: cb.amount, status: cb.status, payload: cb.payload }) });
}));

// DEVELOPMENT ONLY: the fake gateway's "succeed / fail" buttons call this. It is not even mounted in production or with a real provider.
if (env.NODE_ENV !== 'production' && getProvider().name === 'mock') {
  paymentsRouter.post('/mock/confirm', validate(z.object({ ref: z.string().min(5).max(80), outcome: z.enum(['success', 'fail']) })), asyncHandler(async (req, res) => {
    const { data: pay } = await db.from('payments').select('order_id,amount').eq('provider', 'mock').eq('provider_ref', req.body.ref).maybeSingle();
    if (!pay) throw new HttpError(404, 'Unknown payment');
    res.json({ result: await applyPaymentResult({ provider: 'mock', eventId: `${req.body.ref}:${req.body.outcome}`, providerRef: req.body.ref, orderId: pay.order_id,
      amount: Number(pay.amount), status: req.body.outcome === 'success' ? 'PAID' : 'FAILED' }) });
  }));
}
