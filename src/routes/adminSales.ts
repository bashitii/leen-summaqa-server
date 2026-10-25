// ADMIN: orders, customers, discounts, countries + shipping rates. (Products/collections/uploads live in admin.ts.)
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../supabase';
import { requireAdmin } from '../middleware/auth';
import { asyncHandler, HttpError, validate } from '../middleware/error';
import { refundOrder } from '../payments/service';
import { notifyOrderShipped } from '../email/notify';
import { clearCurrencyCache } from '../pricing';
import { syncRates } from '../fxSync';

export const adminSalesRouter = Router();
adminSalesRouter.use(requireAdmin);

const check = (error: { code?: string; message: string } | null) => {
  if (!error) return;
  if (error.code === '23505') throw new HttpError(409, 'That value already exists');
  if (error.code === '23503') throw new HttpError(409, 'Remove the items that depend on this first (for example its shipping rates)');
  throw error;
};

// ---------------------------------------------------------------- ORDERS
const STATUSES = ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;
adminSalesRouter.get('/orders', asyncHandler(async (req, res) => {
  const status = z.enum(STATUSES).optional().parse(req.query.status || undefined);
  let q = db.from('orders').select('id,order_number,email,total,currency,status,payment_status,is_preorder,created_at').order('created_at', { ascending: false }).limit(200);
  if (status) q = q.eq('status', status);
  const { data, error } = await q; if (error) throw error; res.json(data);
}));
adminSalesRouter.get('/orders/:id', asyncHandler(async (req, res) => {
  const { data: o } = await db.from('orders').select('*, order_items(*), payments(*)').eq('id', req.params.id).maybeSingle();
  if (!o) throw new HttpError(404, 'Order not found');
  const { public_token, ...order } = o;                       // the guest secret is never shown in the admin UI
  const { data: profile } = o.user_id ? await db.from('customer_profiles').select('first_name,last_name,phone').eq('user_id', o.user_id).maybeSingle() : { data: null };
  res.json({ ...order, customer: profile });
}));
// Status changes. Cancelling goes through cancel_order() so reserved stock is put back exactly once. A cancelled order is final.
adminSalesRouter.patch('/orders/:id/status', validate(z.object({ status: z.enum(STATUSES) })), asyncHandler(async (req, res) => {
  const { data: o } = await db.from('orders').select('status').eq('id', req.params.id).maybeSingle();
  if (!o) throw new HttpError(404, 'Order not found');
  if (o.status === 'CANCELLED') throw new HttpError(409, 'A cancelled order cannot be changed');
  if (req.body.status === 'CANCELLED') { const { error } = await db.rpc('cancel_order', { p_order_id: req.params.id }); check(error); }
  else { const { error } = await db.from('orders').update({ status: req.body.status }).eq('id', req.params.id); check(error); }
  if (req.body.status === 'SHIPPED' && o.status !== 'SHIPPED') void notifyOrderShipped(req.params.id);   // email the customer once
  res.json({ ok: true });
}));

// Refund the paid payment through the active gateway (fails clearly until the real gateway is connected). Cancelling the order is a separate step.
adminSalesRouter.post('/orders/:id/refund', asyncHandler(async (req, res) => { await refundOrder(req.params.id); res.json({ ok: true }); }));

// ---------------------------------------------------------------- CUSTOMERS (read-only)
adminSalesRouter.get('/customers', asyncHandler(async (_req, res) => {
  const { data: users, error } = await db.from('users').select('id,email,created_at, customer_profiles(first_name,last_name,phone)').eq('role', 'CUSTOMER').order('created_at', { ascending: false }).limit(300);
  if (error) throw error;
  const { data: orders } = await db.from('orders').select('user_id,total,payment_status').not('user_id', 'is', null);
  const stats = new Map<string, { n: number; spent: number }>();
  (orders ?? []).forEach((o) => { const s = stats.get(o.user_id) ?? { n: 0, spent: 0 }; s.n++; if (o.payment_status === 'PAID') s.spent += Number(o.total); stats.set(o.user_id, s); });
  res.json((users ?? []).map((u: any) => ({ id: u.id, email: u.email, created_at: u.created_at, profile: u.customer_profiles, orders: stats.get(u.id)?.n ?? 0, spent: stats.get(u.id)?.spent ?? 0 })));
}));

// ---------------------------------------------------------------- DISCOUNT CODES
const discountIn = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/).transform((s) => s.toUpperCase()),
  type: z.enum(['PERCENT', 'FIXED']), value: z.number().positive().max(1_000_000), min_subtotal: z.number().min(0).default(0),
  max_uses: z.number().int().positive().nullish(), starts_at: z.string().datetime().nullish(), expires_at: z.string().datetime().nullish(), is_active: z.boolean().default(true),
}).refine((d) => d.type !== 'PERCENT' || d.value <= 100, { message: 'A percentage cannot exceed 100', path: ['value'] });
adminSalesRouter.get('/discounts', asyncHandler(async (_req, res) => { res.json((await db.from('discount_codes').select('*').order('code')).data); }));
adminSalesRouter.post('/discounts', validate(discountIn), asyncHandler(async (req, res) => { const { data, error } = await db.from('discount_codes').insert(req.body).select().single(); check(error); res.status(201).json(data); }));
adminSalesRouter.put('/discounts/:id', validate(discountIn), asyncHandler(async (req, res) => { const { data, error } = await db.from('discount_codes').update(req.body).eq('id', req.params.id).select().single(); check(error); res.json(data); }));
adminSalesRouter.delete('/discounts/:id', asyncHandler(async (req, res) => { check((await db.from('discount_codes').delete().eq('id', req.params.id)).error); res.status(204).end(); }));

// ---------------------------------------------------------------- COUNTRIES + SHIPPING RATES (Settings)
const countryIn = z.object({ name: z.string().trim().min(1).max(80), currency: z.string().length(3).toUpperCase(), ships_to: z.boolean() });
adminSalesRouter.get('/countries', asyncHandler(async (_req, res) => { res.json((await db.from('countries').select('*').order('name')).data); }));
adminSalesRouter.put('/countries/:code', validate(countryIn), asyncHandler(async (req, res) => {
  const code = z.string().length(2).transform((s) => s.toUpperCase()).parse(req.params.code);
  check((await db.from('countries').upsert({ code, ...req.body }, { onConflict: 'code' })).error); res.json({ ok: true });
}));
adminSalesRouter.delete('/countries/:code', asyncHandler(async (req, res) => { check((await db.from('countries').delete().eq('code', req.params.code.toUpperCase())).error); res.status(204).end(); }));

const rateIn = z.object({ country_code: z.string().length(2).toUpperCase(), min_subtotal: z.number().min(0).default(0), price: z.number().min(0).max(100000), is_active: z.boolean().default(true) });
adminSalesRouter.get('/shipping-rates', asyncHandler(async (_req, res) => { res.json((await db.from('shipping_rates').select('*').order('country_code').order('min_subtotal')).data); }));
adminSalesRouter.post('/shipping-rates', validate(rateIn), asyncHandler(async (req, res) => { const { data, error } = await db.from('shipping_rates').insert(req.body).select().single(); check(error); res.status(201).json(data); }));
adminSalesRouter.delete('/shipping-rates/:id', asyncHandler(async (req, res) => { check((await db.from('shipping_rates').delete().eq('id', req.params.id)).error); res.status(204).end(); }));

// ---------------------------------------------------------------- CURRENCIES (Settings)
// Rates are NOT editable: the server pulls them live (fxSync.ts). The owner only chooses the rounding and which currencies are ON.
// Only switch ON currencies your payment account can actually charge.
const currencyIn = z.object({ name: z.string().trim().min(1).max(60), symbol: z.string().trim().min(1).max(8),
  decimals: z.number().int().min(0).max(3), round_step: z.number().positive().max(1000), is_active: z.boolean() });
adminSalesRouter.get('/currencies', asyncHandler(async (_req, res) => { res.json((await db.from('currencies').select('*').order('sort_order')).data); }));
// "Refresh now" button: pulls today's live rates immediately.
adminSalesRouter.post('/currencies/refresh', asyncHandler(async (_req, res) => { res.json(await syncRates()); }));
adminSalesRouter.put('/currencies/:code', validate(currencyIn), asyncHandler(async (req, res) => {
  const code = z.string().length(3).transform((x) => x.toUpperCase()).parse(req.params.code);
  if (code === 'JOD' && !req.body.is_active) throw new HttpError(400, 'JOD is the base currency and stays on');
  check((await db.from('currencies').update(req.body).eq('code', code)).error);   // update only: the rate column is never touched here
  clearCurrencyCache(); res.json({ ok: true });
}));
