// sitemap.xml: a list of every public page, so search engines find new products and collections quickly.
// Built from the database each time (cached for an hour), so it is never out of date.
import { Router } from 'express';
import { db } from '../supabase';
import { env } from '../config';
import { asyncHandler } from '../middleware/error';

export const seoRouter = Router();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

seoRouter.get('/sitemap.xml', asyncHandler(async (_req, res) => {
  const base = env.SITE_URL.replace(/\/$/, '');
  const [products, collections, pages, posts] = await Promise.all([
    db.from('products').select('slug,updated_at').eq('is_active', true),
    db.from('collections').select('slug,updated_at').eq('is_active', true),
    db.from('homepage_content').select('section').like('section', 'page\\_%').eq('is_active', true),
    db.from('journal_posts').select('slug,updated_at').eq('is_active', true),
  ]);
  const urls: { loc: string; lastmod?: string; priority: string }[] = [
    { loc: '/', priority: '1.0' }, { loc: '/shop', priority: '0.9' }, { loc: '/collections', priority: '0.8' }, { loc: '/leens-world', priority: '0.7' },
    ...(posts.data ?? []).map((p) => ({ loc: `/leens-world/journal/${p.slug}`, lastmod: p.updated_at, priority: '0.6' })),
    ...(pages.data ?? []).map((p) => ({ loc: `/${p.section.slice(5)}`, priority: '0.4' })),
    ...(collections.data ?? []).map((c) => ({ loc: `/collections/${c.slug}`, lastmod: c.updated_at, priority: '0.8' })),
    ...(products.data ?? []).map((p) => ({ loc: `/products/${p.slug}`, lastmod: p.updated_at, priority: '0.9' })),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) =>
    `  <url><loc>${esc(base + u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ''}<priority>${u.priority}</priority></url>`).join('\n')}\n</urlset>\n`;
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(xml);
}));
