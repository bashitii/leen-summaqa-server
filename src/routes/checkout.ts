// CHECKOUT. Flow: the browser sends contact + address (never prices). We load the cart from the DB, work out
// shipping and discount ourselves, and create the order inside ONE database transaction (create_order_from_cart).
// Payment is NOT taken here: the order is created as PENDING/PENDING. Phase 7 connects the payment gateway (HyperPay) to it.
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../supabase';
import { optionalAuth } from '../middleware/auth';
import { asyncHandler, HttpError, validate } from '../middleware/error';
import { discountFor, findCart, view } from './cart';
import { Currency, FALLBACK, convert, getCurrency } from '../pricing';

export const checkoutRouter = Router();
checkoutRouter.use(optionalAuth);

const address = z.object({
  recipient: z.string().trim().min(1).max(100), line1: z.string().trim().min(1).max(200), line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100), region: z.string().trim().max(100).optional(), postal_code: z.string().trim().max(20).optional(),
  country_code: z.string().length(2).toUpperCase(), phone: z.string().trim().max(30).optional(),
}).strict();

// Shipping comes from the admin-managed tables: country must be enabled, and the best matching rate wins
// (highest min_subtotal not above the cart subtotal, so "free over X" thresholds just work). Nothing is hard-coded.
async function shippingFor(country: string, subtotalBase: number, cur: Currency): Promise<number> {
  const { data: c } = await db.from('countries').select('ships_to').eq('code', country).maybeSingle();
  if (!c?.ships_to) throw new HttpError(400, 'We do not ship to this country yet');
  const { data: rates } = await db.from('shipping_rates').select('price'
  ).eq('country_code', country).eq('is_active', true)
    .lte('min_subtotal', subtotalBase).order('min_subtotal', { ascending: false }).limit(1);
  if (!rates?.length) throw new HttpError(400, 'Shipping for this country is not set up yet');
  return convert(Number(rates[0].price), cur);          // rates and thresholds are entered in JOD; the customer pays the converted amount
}
const round = (n: number, dec: number) => Number(n.toFixed(dec));

// Price preview for the checkout page (changes when the country or code changes).
checkoutRouter.post('/quote', validate(z.object({ country_code: z.string().length(2).toUpperCase(), discount_code: z.string().trim().max(40).optional() })),
  asyncHandler(async (req, res) => {
    const cart = await findCart(req), bag = await view(cart), cur = (await getCurrency(cart.currency)) ?? FALLBACK, { subtotal } = bag, currency = cart.currency;
    let discount = 0, discountError: string | null = null, shipping: number | null = null, shippingError: string | null = null;
    if (req.body.discount_code) { try { discount = (await discountFor(req.body.discount_code, bag, cur)).discount_total; } catch (e) { discountError = (e as Error).message; } }
    try { shipping = await shippingFor(req.body.country_code, bag.subtotal_base, cur); } catch (e) { if (e instanceof HttpError) shippingError = e.message; else throw e; }
    res.json({ currency, subtotal, discount_total: discount, discount_error: discountError, shipping_total: shipping, shipping_error: shippingError,
      total: shipping === null ? null : round(subtotal - discount + shipping, cur.decimals) });
  }));

// Friendly messages for the exceptions raised inside create_order_from_cart.
function explain(message: string): HttpError {
  const [code, detail] = message.split(':');
  if (code === 'CART_EMPTY' || code === 'CART_NOT_FOUND') return new HttpError(409, 'Your bag is empty');
  if (code === 'OUT_OF_STOCK') return new HttpError(409, `${detail ?? 'An item'} just sold out. Please update your bag`);
  if (code === 'UNAVAILABLE') return new HttpError(409, `${detail ?? 'An item'} is no longer available`);
  if (code === 'INVALID_DISCOUNT') return new HttpError(400, 'That discount code is not valid for this bag');
  return new HttpError(500, 'Could not place the order');
}

const checkoutIn = z.object({
  email: z.string().email().max(254), phone: z.string().trim().min(6).max(30),
  shipping_address: address, billing_address: address.optional(),    // billing defaults to shipping
  discount_code: z.string().trim().max(40).optional(),
});
checkoutRouter.post('/', validate(checkoutIn), asyncHandler(async (req, res) => {
  const b = req.body as z.infer<typeof checkoutIn>;
  const cart = await findCart(req), bag = await view(cart), cur = (await getCurrency(cart.currency)) ?? FALLBACK;
  const shipping = await shippingFor(b.shipping_address.country_code, bag.subtotal_base, cur);     // refuses if we can't ship there
  const { data: orderId, error } = await db.rpc('create_order_from_cart', {          // atomic: stock check + order + snapshots + discount
    p_cart_id: cart.id, p_email: b.email, p_phone: b.phone, p_shipping: b.shipping_address, p_billing: b.billing_address ?? b.shipping_address,
    p_discount_code: b.discount_code ?? null, p_shipping_total: shipping });
  if (error) throw explain(error.message);
  const { data: o } = await db.from('orders').select('id,order_number,public_token,total,currency,status,payment_status').eq('id', orderId).single();
  res.status(201).json(o);
}));

// Order confirmation for signed-in customers (their own orders) AND guests (id + secret token from the confirmation link).
checkoutRouter.get('/orders/:id', asyncHandler(async (req, res) => {
  const { data: o } = await db.from('orders').select('*, order_items(*)').eq('id', req.params.id).maybeSingle();
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const mine = !!o && !!req.user && o.user_id === req.user.id, viaToken = !!o && token !== '' && token === o.public_token;
  if (!o || !(mine || viaToken)) throw new HttpError(404, 'Order not found');      // same answer whether it exists or not
  const { public_token, ...safe } = o; res.json(safe);
}));

// Customer cancels an UNPAID order: stock goes back on sale. Same access rule as viewing it (owner, or the secret token).
// If the payment already went through (or is landing right now) we refuse instead of cancelling a paid order.
checkoutRouter.post('/orders/:id/cancel', validate(z.object({ token: z.string().uuid().optional() })), asyncHandler(async (req, res) => {
  const { data: o } = await db.from('orders').select('id,user_id,public_token,status,payment_status').eq('id', req.params.id).maybeSingle();
  const ok = !!o && ((!!req.user && o.user_id === req.user.id) || (!!req.body.token && req.body.token === o.public_token));
  if (!o || !ok) throw new HttpError(404, 'Order not found');
  if (o.status === 'CANCELLED') return void res.json({ ok: true });                 // already cancelled: nothing to do
  const { data: changed } = await db.from('orders').update({ payment_status: 'FAILED' }).eq('id', o.id).eq('payment_status', 'PENDING').select('id');
  if (!changed?.length) throw new HttpError(409, 'This order is already paid or being processed');
  await db.from('payments').update({ status: 'FAILED' }).eq('order_id', o.id).eq('status', 'PENDING');
  await db.rpc('cancel_order', { p_order_id: o.id });                               // releases the reserved stock (idempotent)
  res.json({ ok: true });
}));
