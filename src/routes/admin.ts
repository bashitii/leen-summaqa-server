// ADMIN API. Every route sits behind requireAdmin, which checks the role in OUR database on every request
// (a customer can't reach this even by editing the frontend). Phase 4 = dashboard stats, products + inventory,
// collections and image upload. Orders / customers / discounts / content come in later phases.
import express, { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { db } from '../supabase';
import { requireAdmin } from '../middleware/auth';
import { asyncHandler, HttpError, validate } from '../middleware/error';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// Turn a Postgres error into a friendly HTTP error (23505 = unique violation, e.g. duplicate slug/SKU).
const check = (error: { code?: string; message: string } | null) => {
  if (!error) return;
  if (error.code === '23505') throw new HttpError(409, 'That slug or SKU is already used');
  throw error;
};
const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

// ---------------------------------------------------------------- DASHBOARD
adminRouter.get('/stats', asyncHandler(async (_req, res) => {
  const count = async (t: string) => (await db.from(t).select('*', { count: 'exact', head: true })).count ?? 0;
  const [orders, products] = await Promise.all([count('orders'), count('products')]);
  const { count: customers } = await db.from('users').select('*', { count: 'exact', head: true }).eq('role', 'CUSTOMER');
  const { data: paid } = await db.from('orders').select('total,fx_rate').eq('payment_status', 'PAID');
  const revenue = Math.round((paid ?? []).reduce((s, o) => s + Number(o.total) / Number(o.fx_rate), 0) * 1000) / 1000;   // every order converted back to JOD   // fine at startup scale; move to SQL later
  const { data: inv } = await db.from('inventory').select('quantity');
  const { data: recent } = await db.from('orders').select('id,order_number,email,total,currency,status,payment_status,created_at')
    .order('created_at', { ascending: false }).limit(8);
  res.json({ revenue, orders, customers: customers ?? 0, products,
    inventory_units: (inv ?? []).reduce((s, r) => s + r.quantity, 0), out_of_stock_variants: (inv ?? []).filter((r) => r.quantity === 0).length, recent_orders: recent });
}));

// ---------------------------------------------------------------- PRODUCTS
const variantIn = z.object({
  id: z.string().uuid().optional(), sku: z.string().trim().max(60).optional(),     // empty SKU = generated automatically
  color_name: z.string().trim().max(40).nullish(), color_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  size_label: z.string().trim().max(40).nullish(), price_override: z.number().min(0).nullish(),
  allow_preorder: z.boolean().default(false), is_active: z.boolean().default(true),
  quantity: z.number().int().min(0).max(100000).default(0),            // stock lives in `inventory`, edited here for convenience
});
// color_index = which colour (position in `variants`) this photo belongs to; null = shared by all colours.
const imageIn = z.object({ url: z.string().url(), alt_text: z.string().max(200).nullish(), is_hover: z.boolean().default(false), color_index: z.number().int().min(0).nullish() });
const productIn = z.object({
  name: z.string().trim().min(1).max(120), slug: z.string().trim().max(80).optional(),
  description: z.string().max(5000).nullish(), material: z.string().max(500).nullish(), dimensions: z.string().max(300).nullish(),
  category_id: z.string().uuid().nullish(), base_price: z.number().min(0).max(1_000_000), currency: z.string().length(3).default('JOD'),
  is_active: z.boolean().default(true), is_featured: z.boolean().default(false), force_sold_out: z.boolean().default(false),
  collection_ids: z.array(z.string().uuid()).default([]),
  variants: z.array(variantIn).min(1).max(40), images: z.array(imageIn).max(20).default([]),
});

const PRODUCT_FULL = '*, product_images(*), product_variants(*, inventory(quantity)), collection_products(collection_id)';
async function getProduct(id: string) {
  const { data } = await db.from('products').select(PRODUCT_FULL).eq('id', id).maybeSingle();
  if (!data) throw new HttpError(404, 'Product not found');
  const { product_images, product_variants, collection_products, search, ...p } = data;
  return { ...p,
    images: [...product_images].sort((a: any, b: any) => a.sort_order - b.sort_order),
    variants: product_variants.map(({ inventory, ...v }: any) => ({ ...v, quantity: inventory?.quantity ?? 0 })),
    collection_ids: collection_products.map((c: any) => c.collection_id) };
}

// Create-or-update. Several small writes (product -> variants -> stock -> images -> collections).
// At this scale that's fine; if it ever needs to be all-or-nothing, move it into one SQL function like create_order_from_cart.
async function saveProduct(id: string | null, b: z.infer<typeof productIn>) {
  // Checked BEFORE anything is written, so a refused save never leaves a half-made product behind.
  const colours = b.variants.map((v) => (v.color_name ?? '').trim().toLowerCase()).filter(Boolean);     // blank names (size-only or single-colour products) are not compared
  if (new Set(colours).size !== colours.length) throw new HttpError(400, 'Two colours have the same name');
  const row = { name: b.name, slug: slugify(b.slug || b.name), description: b.description ?? null, material: b.material ?? null,
    dimensions: b.dimensions ?? null, category_id: b.category_id ?? null, base_price: b.base_price, currency: b.currency.toUpperCase(),
    is_active: b.is_active, is_featured: b.is_featured, force_sold_out: b.force_sold_out };
  if (!row.slug) throw new HttpError(400, 'Name or slug required');
  let pid = id;
  if (id) { const { error } = await db.from('products').update(row).eq('id', id); check(error); }
  else { const { data, error } = await db.from('products').insert(row).select('id').single(); check(error); pid = data!.id; }

  // Variants: only trust incoming ids that really belong to THIS product (stops hijacking another product's variant).
  const { data: existing } = await db.from('product_variants').select('id').eq('product_id', pid!);
  const owned = new Set((existing ?? []).map((v) => v.id));
  const variants = b.variants.map((v) => ({ id: v.id && owned.has(v.id) ? v.id : randomUUID(), product_id: pid!,
    sku: v.sku || `${row.slug}-${(v.color_name ?? 'std').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'std'}-${randomUUID().slice(0, 4)}`,   // auto SKU for new colours
    color_name: v.color_name ?? null, color_hex: v.color_hex ?? null, size_label: v.size_label ?? null, price_override: v.price_override ?? null,
    allow_preorder: v.allow_preorder, is_active: v.is_active }));
  const keep = variants.map((v) => v.id);
  const { error: delErr } = await db.from('product_variants').delete().eq('product_id', pid!).not('id', 'in', `(${keep.join(',')})`); check(delErr);
  const { error: vErr } = await db.from('product_variants').upsert(variants, { onConflict: 'id' }); check(vErr);
  const { error: iErr } = await db.from('inventory').upsert(variants.map((v, i) => ({ variant_id: v.id, quantity: b.variants[i].quantity })), { onConflict: 'variant_id' }); check(iErr);

  // Images: replace the whole set; array position = display order.
  await db.from('product_images').delete().eq('product_id', pid!);
  if (b.images.length) { const { error } = await db.from('product_images').insert(b.images.map((im, i) => ({ product_id: pid!, variant_id: im.color_index != null ? (variants[im.color_index]?.id ?? null) : null, url: im.url, alt_text: im.alt_text ?? null, sort_order: i, is_hover: im.is_hover }))); check(error); }
  // Collections: replace membership.
  await db.from('collection_products').delete().eq('product_id', pid!);
  if (b.collection_ids.length) { const { error } = await db.from('collection_products').insert(b.collection_ids.map((c) => ({ collection_id: c, product_id: pid! }))); check(error); }
  return getProduct(pid!);
}

adminRouter.get('/categories', asyncHandler(async (_req, res) => { res.json((await db.from('categories').select('id,slug,name').order('sort_order')).data); }));

adminRouter.get('/products', asyncHandler(async (_req, res) => {
  const { data, error } = await db.from('products').select('id,slug,name,base_price,currency,is_active,is_featured,force_sold_out,created_at, product_images(url,sort_order), product_variants(allow_preorder, inventory(quantity))').order('created_at', { ascending: false });
  if (error) throw error;
  res.json((data ?? []).map((p: any) => ({ id: p.id, slug: p.slug, name: p.name, base_price: p.base_price, currency: p.currency, is_active: p.is_active, is_featured: p.is_featured, force_sold_out: p.force_sold_out,
    thumb: [...p.product_images].sort((a: any, b: any) => a.sort_order - b.sort_order)[0]?.url ?? null,
    stock: p.product_variants.reduce((s: number, v: any) => s + (v.inventory?.quantity ?? 0), 0) })));
}));
adminRouter.get('/products/:id', asyncHandler(async (req, res) => { res.json(await getProduct(req.params.id)); }));
adminRouter.post('/products', validate(productIn), asyncHandler(async (req, res) => { res.status(201).json(await saveProduct(null, req.body)); }));
adminRouter.put('/products/:id', validate(productIn), asyncHandler(async (req, res) => { res.json(await saveProduct(req.params.id, req.body)); }));
// Deleting is allowed, but order history survives (order_items keep their own snapshot; the FK is ON DELETE SET NULL).
// Prefer "inactive" for pieces you may bring back.
adminRouter.delete('/products/:id', asyncHandler(async (req, res) => { const { error } = await db.from('products').delete().eq('id', req.params.id); check(error); res.status(204).end(); }));

// ---------------------------------------------------------------- COLLECTIONS
const collectionIn = z.object({
  title: z.string().trim().min(1).max(120), slug: z.string().trim().max(80).optional(), description: z.string().max(2000).nullish(),
  intro_text: z.string().max(2000).nullish(), hero_image_url: z.string().url().nullish(), is_active: z.boolean().default(true),
  sort_order: z.number().int().default(0), editorial: z.array(z.object({ url: z.string().url(), caption: z.string().max(200).optional() })).default([]),
  product_ids: z.array(z.string().uuid()).default([]),
});
adminRouter.get('/collections', asyncHandler(async (_req, res) => {
  const { data } = await db.from('collections').select('*, collection_products(product_id)').order('sort_order');
  res.json((data ?? []).map(({ collection_products, ...c }: any) => ({ ...c, product_ids: collection_products.map((x: any) => x.product_id) })));
}));
async function saveCollection(id: string | null, b: z.infer<typeof collectionIn>) {
  const { product_ids, slug, ...rest } = b; const row = { ...rest, slug: slugify(slug || b.title), description: b.description ?? null, intro_text: b.intro_text ?? null, hero_image_url: b.hero_image_url ?? null };
  let cid = id;
  if (id) { const { error } = await db.from('collections').update(row).eq('id', id); check(error); }
  else { const { data, error } = await db.from('collections').insert(row).select('id').single(); check(error); cid = data!.id; }
  await db.from('collection_products').delete().eq('collection_id', cid!);
  if (product_ids.length) { const { error } = await db.from('collection_products').insert(product_ids.map((p, i) => ({ collection_id: cid!, product_id: p, sort_order: i }))); check(error); }
  return { id: cid };
}
adminRouter.post('/collections', validate(collectionIn), asyncHandler(async (req, res) => { res.status(201).json(await saveCollection(null, req.body)); }));
adminRouter.put('/collections/:id', validate(collectionIn), asyncHandler(async (req, res) => { res.json(await saveCollection(req.params.id, req.body)); }));
adminRouter.delete('/collections/:id', asyncHandler(async (req, res) => { const { error } = await db.from('collections').delete().eq('id', req.params.id); check(error); res.status(204).end(); }));

// ---------------------------------------------------------------- IMAGE UPLOAD
// The browser sends the raw image bytes; WE store them in Supabase Storage with the service-role key (never exposed to the browser).
// Only whitelisted image types, max 8 MB, random file names (no user-controlled paths).
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' };
adminRouter.post('/uploads', express.raw({ type: Object.keys(EXT), limit: '8mb' }), asyncHandler(async (req, res) => {
  const bucket = z.enum(['products', 'campaigns', 'editorial', 'branding']).parse(req.query.bucket);
  const type = (req.headers['content-type'] ?? '').split(';')[0];
  if (!EXT[type] || !Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Upload a JPG, PNG, WebP or AVIF image (max 8 MB)');
  // Responsive images: the admin sends the same picture three times (w=480, 960, 1600) with a shared `name`; they are stored as
  // <name>-<w>.webp and the page picks the smallest one that fits the screen (srcset). Without these fields we keep one random file name.
  const q = z.object({ name: z.string().uuid().optional(), w: z.coerce.number().refine((n) => [480, 960, 1600].includes(n)).optional() }).parse(req.query);
  const path = q.name && q.w && type === 'image/webp' ? `${q.name}-${q.w}.webp` : `${randomUUID()}.${EXT[type]}`;
  const { error } = await db.storage.from(bucket).upload(path, req.body, { contentType: type, cacheControl: '31536000' });   // 1-year browser cache
  if (error) throw error;
  res.status(201).json({ url: db.storage.from(bucket).getPublicUrl(path).data.publicUrl });
}));
