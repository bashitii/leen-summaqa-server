// PUBLIC content: homepage sections, info pages, newsletter signup, contact form.
// The admin edits this content (routes/adminContent.ts); `review_note` is an admin-only reminder and is never sent to the public.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../supabase';
import { asyncHandler, HttpError, validate } from '../middleware/error';
import { notifyContact } from '../email/notify';

export const contentRouter = Router();
export const PAGE_SLUGS = ['about', 'contact', 'faq', 'shipping', 'returns', 'privacy', 'terms'] as const;
const stripNote = ({ review_note, ...rest }: Record<string, unknown>) => rest;

// Homepage sections as { hero: {...}, press: {...} } (info pages are excluded: they live under /pages/:slug).
contentRouter.get('/homepage', asyncHandler(async (_req, res) => {
  const { data } = await db.from('homepage_content').select('section,data').eq('is_active', true).not('section', 'like', 'page\\_%');
  res.set('Cache-Control', 'public, max-age=60');
  res.json(Object.fromEntries((data ?? []).map((r) => [r.section, stripNote(r.data)])));
}));

contentRouter.get('/pages/:slug', asyncHandler(async (req, res) => {
  const slug = req.params.slug;
  if (!(PAGE_SLUGS as readonly string[]).includes(slug)) throw new HttpError(404, 'Page not found');
  const { data } = await db.from('homepage_content').select('data').eq('section', `page_${slug}`).eq('is_active', true).maybeSingle();
  if (!data) throw new HttpError(404, 'Page not found');
  res.set('Cache-Control', 'public, max-age=60');
  res.json(stripNote(data.data));
}));

// JOURNAL (blog): list for the Leen's World page, one post by its web name. Only published (is_active) posts are public.
contentRouter.get('/journal', asyncHandler(async (_req, res) => {
  const { data } = await db.from('journal_posts').select('slug,title,excerpt,image_url,published_at').eq('is_active', true).order('published_at', { ascending: false });
  res.set('Cache-Control', 'public, max-age=60'); res.json(data ?? []);
}));
contentRouter.get('/journal/:slug', asyncHandler(async (req, res) => {
  const { data } = await db.from('journal_posts').select('slug,title,excerpt,body,image_url,published_at').eq('slug', req.params.slug).eq('is_active', true).maybeSingle();
  if (!data) throw new HttpError(404, 'Post not found');
  res.set('Cache-Control', 'public, max-age=60'); res.json(data);
}));

contentRouter.get('/editorial', asyncHandler(async (_req, res) => {
  const { data } = await db.from('editorial_content').select('*').eq('is_active', true).order('sort_order');
  res.json(data);
}));

// Newsletter signup. Duplicate emails (unique index) are treated as success so we don't reveal who is subscribed.
contentRouter.post('/newsletter', validate(z.object({ email: z.string().email().max(254), source: z.string().max(40).optional() })),
  asyncHandler(async (req, res) => {
    const { error } = await db.from('newsletter_subscribers').insert(req.body);
    if (error && error.code !== '23505') throw error;     // 23505 = unique violation
    res.status(201).json({ ok: true });
  }));

// Contact form. The site has no email system yet, so messages are saved and shown in Admin > Messages.
// Protection against spam: a strict rate limit (5 per 15 min per IP) and a hidden "website" field that only bots fill in.
const contactLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false });
contentRouter.post('/contact', contactLimiter, validate(z.object({
  name: z.string().trim().max(100).optional(), email: z.string().email().max(254), phone: z.string().trim().max(30).optional(),
  message: z.string().trim().min(5).max(3000), website: z.string().max(200).optional(),
})), asyncHandler(async (req, res) => {
  const { website, ...msg } = req.body;
  if (!website) { const { error } = await db.from('contact_messages').insert(msg); if (error) throw error; void notifyContact(msg); }   // bots get a fake "ok"
  res.status(201).json({ ok: true });
}));
