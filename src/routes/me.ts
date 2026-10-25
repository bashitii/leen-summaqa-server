// Everything here is scoped to req.user.id — a customer can only ever see/change their OWN rows,
// because every query filters by the id taken from the verified token, not from the URL/body.
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../supabase';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, HttpError, validate } from '../middleware/error';

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get('/', asyncHandler(async (req, res) => {
  const { data } = await db.from('customer_profiles').select('first_name,last_name,phone').eq('user_id', req.user!.id).single();
  res.json({ id: req.user!.id, email: req.user!.email, role: req.user!.role, profile: data });
}));

// .strict() rejects unknown keys outright; there is deliberately no `role` field.
const profile = z.object({
  first_name: z.string().trim().min(1).max(60), last_name: z.string().trim().min(1).max(60),
  phone: z.string().trim().max(30).nullable(),
}).partial().strict();
meRouter.patch('/', validate(profile), asyncHandler(async (req, res) => {
  const { data, error } = await db.from('customer_profiles').update(req.body).eq('user_id', req.user!.id).select().single();
  if (error) throw new HttpError(400, error.message);
  res.json(data);
}));

const address = z.object({
  label: z.string().max(40).optional(), recipient: z.string().trim().min(1).max(100),
  line1: z.string().trim().min(1).max(200), line2: z.string().max(200).optional(),
  city: z.string().trim().min(1).max(100), region: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(), country_code: z.string().length(2).toUpperCase(),
  phone: z.string().max(30).optional(), is_default: z.boolean().optional(),
}).strict();

meRouter.get('/addresses', asyncHandler(async (req, res) => {
  const { data } = await db.from('addresses').select('*').eq('user_id', req.user!.id).order('created_at');
  res.json(data);
}));
meRouter.post('/addresses', validate(address), asyncHandler(async (req, res) => {
  const { data, error } = await db.from('addresses').insert({ ...req.body, user_id: req.user!.id }).select().single();
  if (error) throw new HttpError(400, error.message);
  res.status(201).json(data);
}));
meRouter.put('/addresses/:id', validate(address), asyncHandler(async (req, res) => {
  const { data } = await db.from('addresses').update(req.body).eq('id', req.params.id).eq('user_id', req.user!.id).select().maybeSingle();
  if (!data) throw new HttpError(404, 'Address not found');   // someone else's address looks like "not found" too
  res.json(data);
}));
meRouter.delete('/addresses/:id', asyncHandler(async (req, res) => {
  await db.from('addresses').delete().eq('id', req.params.id).eq('user_id', req.user!.id);
  res.status(204).end();
}));

// Order history (read-only; orders are created by checkout in Phase 6).
meRouter.get('/orders', asyncHandler(async (req, res) => {
  const { data } = await db.from('orders')
    .select('id,order_number,status,payment_status,total,currency,created_at')
    .eq('user_id', req.user!.id).order('created_at', { ascending: false });
  res.json(data);
}));
meRouter.get('/orders/:id', asyncHandler(async (req, res) => {
  const { data } = await db.from('orders').select('*, order_items(*)').eq('id', req.params.id).eq('user_id', req.user!.id).maybeSingle();
  if (!data) throw new HttpError(404, 'Order not found');
  res.json(data);
}));
