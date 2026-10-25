// SERVER-SIDE CART. Why not keep the cart in the browser? Because stock, prices and discounts must be
// checked by the server (the browser can be edited by anyone). The browser only says "add variant X, qty 2".
//
// Who owns a cart?
//   - Logged in  -> the cart whose user_id = your id (found from your verified token).
//   - Guest      -> a cart identified by the pair (x-cart-id, x-cart-token). The token is a random UUID only
//                   the guest's browser knows, so knowing a cart id alone is not enough to read/modify it.
// After login the guest cart is MERGED into the user's cart (POST /cart/merge).
import { Request, Router } from 'express';
import { z } from 'zod';
import { db } from '../supabase';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { asyncHandler, HttpError, validate } from '../middleware/error';
import { BASE, Currency, FALLBACK, convert, getCurrency, percentOff } from '../pricing';

export const cartRouter = Router();
cartRouter.use(optionalAuth);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QTY = 20;
export interface CartRow { id: string; user_id: string | null; guest_token: string; currency: string }

async function guestCart(req: Request): Promise<CartRow | null> {
  const id = req.header('x-cart-id'), token = req.header('x-cart-token');
  if (!id || !token || !UUID.test(id) || !UUID.test(token)) return null;
  const { data } = await db.from('carts').select('*').eq('id', id).eq('guest_token', token).is('user_id', null).maybeSingle();
  return data;
}
async function locateCart(req: Request): Promise<CartRow> {
  if (req.user) {
    const { data } = await db.from('carts').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (data) return data;
    const { data: c, error } = await db.from('carts').insert({ user_id: req.user.id }).select('*').single(); if (error) throw error; return c;
  }
  const g = await guestCart(req); if (g) return g;
  const { data: c, error } = await db.from('carts').insert({}).select('*').single(); if (error) throw error; return c;
}

// The browser says which currency it is showing (x-currency header). The cart follows it, as long as the currency exists and is switched on;
// otherwise the cart keeps its current currency (or falls back to JOD if that one was switched off).
export async function findCart(req: Request): Promise<CartRow> {
  const cart = await locateCart(req);
  const wanted = (req.header('x-currency') || cart.currency).trim().toUpperCase();
  const target = (await getCurrency(wanted)) ? wanted : (await getCurrency(cart.currency)) ? cart.currency : BASE;
  if (target !== cart.currency) { await db.from('carts').update({ currency: target }).eq('id', cart.id); cart.currency = target; }
  return cart;
}

const SELECT = 'quantity, product_variants(id,color_name,size_label,price_override,allow_preorder,is_active, inventory(quantity), products(slug,name,base_price,currency,is_active,force_sold_out, product_images(url,sort_order)))';
// The cart as the browser sees it: prices come from the DB, plus a per-line `issue` if it can't be bought as-is.
export async function view(cart: CartRow) {
  const cur = (await getCurrency(cart.currency)) ?? FALLBACK;
  const { data, error } = await db.from('cart_items').select(SELECT).eq('cart_id', cart.id).order('id');
  if (error) throw error;
  const items = (data ?? []).map((r: any) => {
    const v = r.product_variants, p = v.products, stock = v.inventory?.quantity ?? 0, base = Number(v.price_override ?? p.base_price), unit = convert(base, cur);   // base = JOD price, unit = price in the cart's currency
    const sellable = v.is_active && p.is_active && !p.force_sold_out;
    const max = !sellable ? 0 : v.allow_preorder ? MAX_QTY : Math.min(MAX_QTY, stock);
    return { variant_id: v.id, product_slug: p.slug, name: p.name, variant_label: v.color_name ?? v.size_label ?? null,
      image: [...p.product_images].sort((a: any, b: any) => a.sort_order - b.sort_order)[0]?.url ?? null,
      currency: cart.currency, unit_price: unit, base_line: Math.round(base * r.quantity * 1000) / 1000, quantity: r.quantity, line_total: Math.round(unit * r.quantity * 1000) / 1000, max_quantity: max,
      issue: !sellable ? 'No longer available' : r.quantity > max ? (max === 0 ? 'Sold out' : `Only ${max} left`) : null };
  });
  return { id: cart.id, currency: cart.currency, items, subtotal: Math.round(items.reduce((s, i) => s + i.line_total, 0) * 1000) / 1000,
    subtotal_base: Math.round(items.reduce((s, i) => s + i.base_line, 0) * 1000) / 1000,   // the same bag in JOD: thresholds (free shipping, discount minimums) are set in JOD
    guest: cart.user_id ? undefined : { id: cart.id, token: cart.guest_token } };   // guests need these two to come back to their cart
}

// Inventory validation lives here (and again, atomically, inside create_order_from_cart at checkout).
async function setQty(cart: CartRow, variantId: string, qty: number) {
  if (qty <= 0) { await db.from('cart_items').delete().eq('cart_id', cart.id).eq('variant_id', variantId); return; }
  const { data: v } = await db.from('product_variants').select('id,is_active,allow_preorder, inventory(quantity), products(is_active,force_sold_out)').eq('id', variantId).maybeSingle();
  const p: any = v?.products;
  if (!v || !v.is_active || !p?.is_active || p.force_sold_out) throw new HttpError(409, 'This piece is no longer available');
  const stock = (v as any).inventory?.quantity ?? 0, cap = v.allow_preorder ? MAX_QTY : Math.min(MAX_QTY, stock);
  if (cap === 0) throw new HttpError(409, 'Sold out');
  if (qty > cap) throw new HttpError(409, `Only ${cap} left`);
  const { error } = await db.from('cart_items').upsert({ cart_id: cart.id, variant_id: variantId, quantity: qty }, { onConflict: 'cart_id,variant_id' });
  if (error) throw error;
}
const currentQty = async (cart: CartRow, variantId: string) =>
  (await db.from('cart_items').select('quantity').eq('cart_id', cart.id).eq('variant_id', variantId).maybeSingle()).data?.quantity ?? 0;

cartRouter.get('/', asyncHandler(async (req, res) => { res.json(await view(await findCart(req))); }));

const addIn = z.object({ variant_id: z.string().uuid(), quantity: z.number().int().min(1).max(MAX_QTY).default(1) });
cartRouter.post('/items', validate(addIn), asyncHandler(async (req, res) => {
  const cart = await findCart(req);
  await setQty(cart, req.body.variant_id, (await currentQty(cart, req.body.variant_id)) + req.body.quantity);   // adding twice increases quantity
  res.json(await view(cart));
}));
cartRouter.patch('/items/:variantId', validate(z.object({ quantity: z.number().int().min(0).max(MAX_QTY) })), asyncHandler(async (req, res) => {
  if (!UUID.test(req.params.variantId)) throw new HttpError(400, 'Bad id');
  const cart = await findCart(req); await setQty(cart, req.params.variantId, req.body.quantity); res.json(await view(cart));
}));
cartRouter.delete('/items/:variantId', asyncHandler(async (req, res) => {
  if (!UUID.test(req.params.variantId)) throw new HttpError(400, 'Bad id');
  const cart = await findCart(req); await setQty(cart, req.params.variantId, 0); res.json(await view(cart));
}));

// One discount rule used by BOTH the bag preview and checkout quote (the real, atomic check is inside create_order_from_cart).
// Minimum spend and fixed amounts are set in JOD; percentages apply to whatever currency the customer is paying in.
export async function discountFor(rawCode: string, bag: { subtotal: number; subtotal_base: number }, cur: Currency) {
  const { data: d } = await db.from('discount_codes').select('*').eq('code', rawCode.trim().toUpperCase()).maybeSingle();
  const now = Date.now();
  if (!d || !d.is_active || (d.starts_at && Date.parse(d.starts_at) > now) || (d.expires_at && Date.parse(d.expires_at) < now)
    || (d.max_uses != null && d.used_count >= d.max_uses) || bag.subtotal_base < Number(d.min_subtotal)) throw new HttpError(400, 'That code is not valid for this bag');
  const off = d.type === 'PERCENT' ? percentOff(bag.subtotal, Number(d.value), cur.decimals) : convert(Number(d.value), cur);
  return { code: d.code as string, discount_total: Math.min(bag.subtotal, off) };
}
// Discount PREVIEW only (does not use up the code). The code is applied for real, atomically, at checkout.
cartRouter.post('/discount', validate(z.object({ code: z.string().trim().min(1).max(40) })), asyncHandler(async (req, res) => {
  const cart = await findCart(req), bag = await view(cart);
  res.json(await discountFor(req.body.code, bag, (await getCurrency(cart.currency)) ?? FALLBACK));
}));

// After login: fold the guest cart into the customer's own cart, then delete the guest cart.
cartRouter.post('/merge', requireAuth, asyncHandler(async (req, res) => {
  const mine = await findCart(req), g = await guestCart(req);
  if (g && g.id !== mine.id) {
    const { data: items } = await db.from('cart_items').select('variant_id,quantity').eq('cart_id', g.id);
    for (const it of items ?? []) {
      try { await setQty(mine, it.variant_id, Math.min(MAX_QTY, (await currentQty(mine, it.variant_id)) + it.quantity)); } catch { /* item no longer buyable: skip it */ }
    }
    await db.from('carts').delete().eq('id', g.id);
  }
  res.json(await view(mine));
}));
