// PUBLIC read-only storefront API. Notice we never send raw stock numbers to the browser —
// only a computed `available` / `preorder` flag (competitors shouldn't see your inventory).
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../supabase';
import { asyncHandler, HttpError, validate } from '../middleware/error';
import { activeCurrencies } from '../pricing';

export const catalogRouter = Router();

// One select string = one round trip (no N+1 queries): product + images + variants + stock.
const PRODUCT_SELECT = '*, product_images(url,alt_text,sort_order,is_hover,variant_id), product_variants(id,sku,color_name,color_hex,size_label,price_override,allow_preorder,is_active,inventory(quantity)), categories(slug,name)';

function shape(p: any) {
  const variants = (p.product_variants ?? []).filter((v: any) => v.is_active).map((v: any) => {
    const stock = v.inventory?.quantity ?? 0;
    return { id: v.id, sku: v.sku, color_name: v.color_name, color_hex: v.color_hex, size_label: v.size_label,
      price: v.price_override ?? p.base_price,
      available: !p.force_sold_out && (stock > 0 || v.allow_preorder),   // buyable right now?
      preorder: stock <= 0 && v.allow_preorder };                          // buyable only as pre-order?
  });
  const images = [...(p.product_images ?? [])].sort((a, b) => a.sort_order - b.sort_order);
  const { product_images, product_variants, categories, search, ...rest } = p;
  // Cards show the DEFAULT colour (first buyable one): its photos + shared photos. The product page switches photos per colour itself.
  const def = variants.find((v: any) => v.available) ?? variants[0];
  const cardImgs = images.filter((i: any) => !i.variant_id || i.variant_id === def?.id);
  return { ...rest, category: categories, images, hover_image: cardImgs.find((i: any) => i.is_hover) ?? cardImgs[1] ?? null,
    variants, sold_out: variants.every((v: any) => !v.available) };
}

const listQuery = z.object({
  category: z.string().optional(), collection: z.string().optional(), color: z.string().optional(),
  min_price: z.coerce.number().min(0).optional(), max_price: z.coerce.number().min(0).optional(),
  sort: z.enum(['featured', 'newest', 'price_asc', 'price_desc']).default('featured'),
  limit: z.coerce.number().int().min(1).max(60).default(24), offset: z.coerce.number().int().min(0).default(0),
});

catalogRouter.get('/products', validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.query as unknown as z.infer<typeof listQuery>;
  let ids: string[] | null = null;                       // restrict to a collection / category if asked
  if (q.collection) {
    const { data: col } = await db.from('collections').select('id').eq('slug', q.collection).eq('is_active', true).maybeSingle();
    if (!col) return res.json({ items: [], total: 0 });
    const { data } = await db.from('collection_products').select('product_id').eq('collection_id', col.id);
    ids = (data ?? []).map((r) => r.product_id);
  }
  let query = db.from('products').select(PRODUCT_SELECT, { count: 'exact' }).eq('is_active', true);
  if (ids) query = query.in('id', ids);
  if (q.category) {
    const { data: cat } = await db.from('categories').select('id').eq('slug', q.category).maybeSingle();
    if (!cat) return res.json({ items: [], total: 0 });
    query = query.eq('category_id', cat.id);
  }
  if (q.min_price !== undefined) query = query.gte('base_price', q.min_price);
  if (q.max_price !== undefined) query = query.lte('base_price', q.max_price);
  if (q.sort === 'price_asc') query = query.order('base_price', { ascending: true });
  else if (q.sort === 'price_desc') query = query.order('base_price', { ascending: false });
  else if (q.sort === 'newest') query = query.order('created_at', { ascending: false });
  else query = query.order('is_featured', { ascending: false }).order('created_at', { ascending: false });
  const { data, count, error } = await query.range(q.offset, q.offset + q.limit - 1);
  if (error) throw error;
  let items = (data ?? []).map(shape);
  if (q.color) items = items.filter((p) => p.variants.some((v: any) => v.color_name?.toLowerCase() === q.color!.toLowerCase()));
  res.set('Cache-Control', 'public, max-age=60');        // CDN/browser may cache a minute -> faster on mobile
  res.json({ items, total: count ?? items.length });
}));

catalogRouter.get('/products/:slug', asyncHandler(async (req, res) => {
  const { data } = await db.from('products').select(PRODUCT_SELECT).eq('slug', req.params.slug).eq('is_active', true).maybeSingle();
  if (!data) throw new HttpError(404, 'Product not found');
  // "You may also like": same category, excluding itself.
  const { data: rel } = await db.from('products').select(PRODUCT_SELECT).eq('is_active', true)
    .eq('category_id', data.category_id).neq('id', data.id).limit(4);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ ...shape(data), related: (rel ?? []).map(shape) });
}));

catalogRouter.get('/collections', asyncHandler(async (_req, res) => {
  const { data } = await db.from('collections').select('id,slug,title,description,hero_image_url').eq('is_active', true).order('sort_order');
  res.json(data);
}));
catalogRouter.get('/collections/:slug', asyncHandler(async (req, res) => {
  const { data } = await db.from('collections').select('*').eq('slug', req.params.slug).eq('is_active', true).maybeSingle();
  if (!data) throw new HttpError(404, 'Collection not found');
  res.json(data);                                         // products come from /products?collection=slug
}));

// Full-text search using the generated tsvector column + GIN index from the schema.
catalogRouter.get('/search', validate(z.object({ q: z.string().trim().min(2).max(80) }), 'query'), asyncHandler(async (req, res) => {
  const { data, error } = await db.from('products').select(PRODUCT_SELECT).eq('is_active', true)
    .textSearch('search', (req.query as any).q, { type: 'websearch', config: 'simple' }).limit(24);
  if (error) throw error;
  res.json({ items: (data ?? []).map(shape) });
}));

catalogRouter.get('/countries', asyncHandler(async (_req, res) => {
  const { data } = await db.from('countries').select('code,name,currency,ships_to').order('name');
  res.json(data);
}));

catalogRouter.get('/categories', asyncHandler(async (_req, res) => {
  const { data } = await db.from('categories').select('slug,name').order('sort_order');
  res.set('Cache-Control', 'public, max-age=300');
  res.json(data);
}));

// Currencies the customer can choose (rate = units per 1 JOD). The browser uses them only to DISPLAY prices; charges are computed here.
catalogRouter.get('/currencies', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json(await activeCurrencies());
}));
