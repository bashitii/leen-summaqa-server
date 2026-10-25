// ADMIN: edit homepage sections + info pages, and read contact-form messages. Everything is behind requireAdmin.
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../supabase';
import { requireAdmin } from '../middleware/auth';
import { asyncHandler, HttpError, validate } from '../middleware/error';

export const adminContentRouter = Router();
adminContentRouter.use(requireAdmin);

// Only these sections can exist (nobody can invent new keys through the API).
const SECTIONS = ['hero', 'featured_collection', 'campaign', 'press', 'story', 'clique', 'newsletter', 'world', 'featured',
  'page_about', 'page_contact', 'page_faq', 'page_shipping', 'page_returns', 'page_privacy', 'page_terms'] as const;

// Any value stored under a key ending in "url" must be empty, a site path, or http(s): this blocks "javascript:" links.
function checkUrls(v: unknown, key = ''): void {
  if (typeof v === 'string' && /(^|_)url$/.test(key) && v !== '' && !/^(https?:\/\/|\/)/.test(v)) throw new HttpError(400, `"${key}" must start with https:// or /`);
  if (Array.isArray(v)) v.forEach((x) => checkUrls(x, key));
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => checkUrls(x, k));
}

adminContentRouter.get('/content', asyncHandler(async (_req, res) => {
  const { data } = await db.from('homepage_content').select('section,data,is_active,updated_at');
  res.json(Object.fromEntries((data ?? []).map((r) => [r.section, { data: r.data, is_active: r.is_active }])));
}));

adminContentRouter.put('/content/:section', validate(z.object({ data: z.record(z.unknown()), is_active: z.boolean().default(true) })), asyncHandler(async (req, res) => {
  const section = z.enum(SECTIONS).parse(req.params.section);
  if (JSON.stringify(req.body.data).length > 60_000) throw new HttpError(413, 'That content is too long');
  checkUrls(req.body.data);
  const { error } = await db.from('homepage_content').upsert({ section, data: req.body.data, is_active: req.body.is_active }, { onConflict: 'section' });
  if (error) throw error;
  res.json({ ok: true });
}));

// JOURNAL (blog posts): list all (including hidden), create, edit, delete. Image URLs obey the same "https:// or /" rule as the other content.
const postIn = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Web name: lowercase letters, numbers and dashes only').max(120),
  title: z.string().trim().min(1).max(200), excerpt: z.string().trim().max(400).default(''), body: z.string().max(40_000).default(''),
  image_url: z.string().trim().max(1000).default(''), published_at: z.string().datetime({ offset: true }).optional(), is_active: z.boolean().default(true),
});
adminContentRouter.get('/journal', asyncHandler(async (_req, res) => {
  res.json((await db.from('journal_posts').select('*').order('published_at', { ascending: false })).data);
}));
adminContentRouter.post('/journal', validate(postIn), asyncHandler(async (req, res) => {
  checkUrls(req.body);
  const { data, error } = await db.from('journal_posts').insert(req.body).select('id').single();
  if (error) throw new HttpError(error.code === '23505' ? 409 : 400, error.code === '23505' ? 'That web name is already used by another post' : error.message);
  res.status(201).json(data);
}));
adminContentRouter.put('/journal/:id', validate(postIn), asyncHandler(async (req, res) => {
  checkUrls(req.body);
  const { error } = await db.from('journal_posts').update(req.body).eq('id', req.params.id);
  if (error) throw new HttpError(error.code === '23505' ? 409 : 400, error.code === '23505' ? 'That web name is already used by another post' : error.message);
  res.json({ ok: true });
}));
adminContentRouter.delete('/journal/:id', asyncHandler(async (req, res) => {
  const { error } = await db.from('journal_posts').delete().eq('id', req.params.id);
  if (error) throw error;
  res.status(204).end();
}));

adminContentRouter.get('/messages', asyncHandler(async (_req, res) => {
  res.json((await db.from('contact_messages').select('*').order('created_at', { ascending: false }).limit(200)).data);
}));
adminContentRouter.patch('/messages/:id', validate(z.object({ is_handled: z.boolean() })), asyncHandler(async (req, res) => {
  const { error } = await db.from('contact_messages').update({ is_handled: req.body.is_handled }).eq('id', req.params.id);
  if (error) throw error;
  res.json({ ok: true });
}));
