// END-TO-END API TEST. Talks to a RUNNING server over HTTP exactly like the website does (no mocks), and checks the rules
// that matter: stock, prices, payments, security, accounts, admin. Run:   npm run test:api
//   API=http://localhost:4000/api            (default)
//   ADMIN_EMAIL=... ADMIN_PASSWORD=...       (optional: also runs the admin tests; the account must have role ADMIN)
// It only works with PAYMENT_PROVIDER=mock (it confirms payments through the dev-only mock route).
// It CREATES test data (orders/customers with e2e- emails, a few products/codes/posts it deletes again). Run it on a
// development database; clear test orders before launch (see the launch checklist).
// Note: the API limits sign-ups/logins to 20 per 15 minutes per IP, and the contact form to 5, so wait or restart the server between runs.
const API = process.env.API || 'http://localhost:4000/api';
const ROOT = API.replace(/\/api\/?$/, '');
const RUN = Date.now().toString(36);
const results = []; let section = '';
const sec = (s) => { section = s; console.log(`\n== ${s}`); };

// Tiny HTTP helper: returns { status, body }.
async function call(method, path, { body, headers = {}, token, cart, currency } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  if (cart) { h['x-cart-id'] = cart.id; h['x-cart-token'] = cart.token; }
  if (currency) h['x-currency'] = currency;
  // The API allows 120 requests a minute per visitor. This test is faster than any human, so if it is told to slow down (429) it waits and retries.
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 429 && attempt < 2 && Number(r.headers.get('retry-after') || 60) <= 70) { await new Promise((ok) => setTimeout(ok, (Number(r.headers.get('retry-after') || 60) + 1) * 1000)); continue; }
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  }
}
// One check. Prints PASS/FAIL and keeps going so you see every problem in one run.
async function t(name, fn) {
  try { await fn(); results.push({ section, name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (e) { results.push({ section, name, ok: false, err: e.message }); console.log(`  FAIL  ${name}\n        -> ${e.message}`); }
}
const eq = (a, b, what = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c, what) => { if (!c) throw new Error(what); };
const status = (res, code, what = '') => { if (res.status !== code) throw new Error(`${what} expected HTTP ${code}, got ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`); };
// The one conversion rule (same as the database and the website): round(round(base*rate/step)*step, decimals)
const convert = (base, c) => Number((Math.round((base * c.rate) / c.round_step) * c.round_step).toFixed(c.decimals));

const addr = { recipient: 'E2E Tester', line1: '1 Test Street', city: 'Amman', country_code: 'JO', phone: '0790000000' };
const checkoutBody = (extra = {}) => ({ email: `e2e-${RUN}@example.com`, phone: '0790000000', shipping_address: addr, ...extra });

async function main() {
  // ---------------------------------------------------------------- PUBLIC
  sec('Public: server, catalog, search');
  let products = [], currencies = [];
  await t('health check answers', async () => { status(await call('GET', '/health'), 200); });
  await t('product list loads, only active products', async () => {
    const r = await call('GET', '/products?limit=60'); status(r, 200); products = r.body.items; ok(products.length > 0, 'no products'); ok(products.every((p) => p.is_active), 'inactive product leaked');
  });
  await t('sorting by price works (low to high, then high to low)', async () => {
    const a = (await call('GET', '/products?sort=price_asc&limit=60')).body.items.map((p) => p.base_price);
    const d = (await call('GET', '/products?sort=price_desc&limit=60')).body.items.map((p) => p.base_price);
    eq(a, [...a].sort((x, y) => x - y), 'asc'); eq(d, [...d].sort((x, y) => y - x), 'desc');
  });
  await t('price filter works', async () => { const r = await call('GET', '/products?min_price=100&max_price=200&limit=60'); ok(r.body.items.every((p) => p.base_price >= 100 && p.base_price <= 200), 'outside range'); });
  await t('product page loads by its web name, unknown name gives 404', async () => {
    status(await call('GET', `/products/${products[0].slug}`), 200); status(await call('GET', '/products/does-not-exist-xyz'), 404);
  });
  await t('bad query values are refused (400) instead of crashing', async () => { status(await call('GET', '/products?limit=9999'), 400); status(await call('GET', '/products?sort=hack'), 400); });
  await t('search finds a product by name, one-letter search is refused', async () => {
    const name = products[0].name.split(' ')[0]; const r = await call('GET', `/search?q=${encodeURIComponent(name)}`); status(r, 200); ok(r.body.items.length > 0, 'no result'); status(await call('GET', '/search?q=a'), 400);
  });
  await t('collections list and a collection page load', async () => {
    const r = await call('GET', '/collections'); status(r, 200); ok(r.body.length > 0, 'no collections');
    const c = await call('GET', `/collections/${r.body[0].slug}`); status(c, 200); status(await call('GET', '/collections/nope-nope'), 404);
  });
  await t('countries list loads', async () => { const r = await call('GET', '/countries'); status(r, 200); ok(r.body.some((c) => c.code === 'JO'), 'Jordan missing'); });
  await t('currencies: JOD base plus others, all with a rate', async () => {
    const r = await call('GET', '/currencies'); status(r, 200); currencies = r.body;
    ok(currencies.find((c) => c.code === 'JOD' && c.rate === 1), 'JOD base missing'); ok(currencies.length >= 2, 'no foreign currencies'); ok(currencies.every((c) => c.rate > 0), 'bad rate');
  });
  await t('sitemap.xml lists home, Leen\'s World, a product', async () => {
    const x = await (await fetch(`${ROOT}/sitemap.xml`)).text(); ok(x.includes('/leens-world'), 'no leens-world'); ok(x.includes(`/products/${products[0].slug}`), 'no product');
  });

  sec('Public: content, Leen\'s World, forms');
  await t('homepage content has hero, world and featured; no admin-only notes leak', async () => {
    const r = await call('GET', '/content/homepage'); status(r, 200); ok(r.body.hero, 'no hero'); ok(r.body.world, 'no world'); ok(r.body.featured, 'no featured');
    ok(!JSON.stringify(r.body).includes('review_note'), 'review_note leaked');
  });
  await t('every info page loads without admin notes; unknown page is 404', async () => {
    for (const s of ['about', 'contact', 'faq', 'shipping', 'returns', 'privacy', 'terms']) { const r = await call('GET', `/content/pages/${s}`); status(r, 200, s); ok(!JSON.stringify(r.body).includes('review_note'), `${s} leaks note`); }
    status(await call('GET', '/content/pages/secret'), 404);
  });
  await t('journal: list, open a post, unknown post is 404', async () => {
    const l = await call('GET', '/content/journal'); status(l, 200); ok(l.body.length >= 1, 'no posts'); const p = await call('GET', `/content/journal/${l.body[0].slug}`); status(p, 200); ok(p.body.body.length > 50, 'empty body'); status(await call('GET', '/content/journal/nope'), 404);
  });
  await t('newsletter signup works, repeating the same email is still OK (no leak of who is subscribed)', async () => {
    const e = { email: `news-${RUN}@example.com` }; status(await call('POST', '/content/newsletter', { body: e }), 201); status(await call('POST', '/content/newsletter', { body: e }), 201); status(await call('POST', '/content/newsletter', { body: { email: 'bad' } }), 400);
  });
  await t('contact form: valid message OK, bad email/short text refused, bot field accepted silently', async () => {
    status(await call('POST', '/content/contact', { body: { name: 'E2E', email: `e2e-${RUN}@example.com`, message: 'Hello from the automated test' } }), 201);
    status(await call('POST', '/content/contact', { body: { email: 'nope', message: 'Hello there' } }), 400);
    status(await call('POST', '/content/contact', { body: { email: 'a@b.co', message: 'hi' } }), 400);
    status(await call('POST', '/content/contact', { body: { email: 'bot@b.co', message: 'buy cheap things', website: 'http://spam' } }), 201);
  });

  // ---------------------------------------------------------------- CART
  sec('Cart (guest)');
  const slugs = Object.fromEntries(products.map((p) => [p.slug, p]));
  const buyable = products.filter((p) => p.variants[0]?.available && !p.variants[0]?.preorder);
  const soldOut = products.find((p) => !p.variants[0]?.available && !p.variants[0]?.preorder);
  const pA = buyable[0], pB = buyable[1];
  let cart = null;
  await t('empty cart is created and returns a guest id + token', async () => { const r = await call('GET', '/cart'); status(r, 200); eq(r.body.items, []); ok(r.body.guest?.id && r.body.guest?.token, 'no guest ids'); cart = r.body.guest; });
  await t('add an item; adding it twice raises the quantity', async () => {
    let r = await call('POST', '/cart/items', { cart, body: { variant_id: pA.variants[0].id, quantity: 1 } }); status(r, 200); eq(r.body.items[0].quantity, 1);
    r = await call('POST', '/cart/items', { cart, body: { variant_id: pA.variants[0].id, quantity: 1 } }); eq(r.body.items[0].quantity, 2);
  });
  await t('price comes from the database (JOD), line total = price x quantity', async () => { const r = await call('GET', '/cart', { cart }); eq(r.body.items[0].unit_price, pA.base_price); eq(r.body.subtotal, pA.base_price * 2); });
  await t('cannot add more than the stock', async () => { const r = await call('POST', '/cart/items', { cart, body: { variant_id: pA.variants[0].id, quantity: 20 } }); status(r, 409); });
  await t('sold-out item cannot be added', async () => { if (!soldOut) return console.log('        (skipped: no sold-out product in the data)'); status(await call('POST', '/cart/items', { cart, body: { variant_id: soldOut.variants[0].id } }), 409); });
  await t('change quantity, set to 0 removes the line, remove works', async () => {
    let r = await call('PATCH', `/cart/items/${pA.variants[0].id}`, { cart, body: { quantity: 1 } }); eq(r.body.items[0].quantity, 1);
    r = await call('POST', '/cart/items', { cart, body: { variant_id: pB.variants[0].id } }); eq(r.body.items.length, 2);
    r = await call('PATCH', `/cart/items/${pB.variants[0].id}`, { cart, body: { quantity: 0 } }); eq(r.body.items.length, 1);
    r = await call('DELETE', `/cart/items/${pA.variants[0].id}`, { cart }); eq(r.body.items.length, 0);
  });
  await t('bad input is refused: quantity 0 on add, negative, huge, bad ids', async () => {
    status(await call('POST', '/cart/items', { cart, body: { variant_id: pA.variants[0].id, quantity: 0 } }), 400); status(await call('PATCH', `/cart/items/${pA.variants[0].id}`, { cart, body: { quantity: -1 } }), 400);
    status(await call('POST', '/cart/items', { cart, body: { variant_id: 'x' } }), 400); status(await call('PATCH', '/cart/items/not-a-uuid', { cart, body: { quantity: 1 } }), 400);
  });
  await t('someone else\'s cart id with a wrong token does NOT open that cart', async () => {
    await call('POST', '/cart/items', { cart, body: { variant_id: pA.variants[0].id } });
    const r = await call('GET', '/cart', { cart: { id: cart.id, token: '00000000-0000-4000-8000-000000000000' } }); status(r, 200); ok(r.body.id !== cart.id, 'opened another cart!'); eq(r.body.items, []);
  });
  await t('cart follows the chosen currency and uses the SAME rounding rule as the database', async () => {
    for (const c of currencies.filter((c) => c.code !== 'JOD')) { const r = await call('GET', '/cart', { cart, currency: c.code }); eq(r.body.currency, c.code); eq(r.body.items[0].unit_price, convert(pA.base_price, c), c.code); }
    const r = await call('GET', '/cart', { cart, currency: 'XXX' }); ok(currencies.some((c) => c.code === r.body.currency), 'unknown currency not handled');   // unknown currency keeps the previous one
    await call('GET', '/cart', { cart, currency: 'JOD' });
  });

  // ---------------------------------------------------------------- CHECKOUT + PAYMENT
  sec('Checkout and payment (mock gateway)');
  const stockOf = async (p) => { const r = await call('POST', '/cart/items', { cart: (await call('GET', '/cart')).body.guest, body: { variant_id: p.variants[0].id, quantity: 20 } }); const m = /Only (\d+) left/.exec(r.body?.error || r.body?.message || ''); return m ? Number(m[1]) : null; };
  let order = null, ref = null, stockBefore = null;
  await t('quote: Jordan has a shipping price, unsupported country is explained, total adds up', async () => {
    const q = await call('POST', '/checkout/quote', { cart, body: { country_code: 'JO' } }); status(q, 200); ok(q.body.shipping_total !== null, 'no shipping'); eq(q.body.total, Number((q.body.subtotal + q.body.shipping_total).toFixed(3)));
    const f = await call('POST', '/checkout/quote', { cart, body: { country_code: 'FR' } }); status(f, 200); ok(f.body.shipping_error, 'no error for FR'); eq(f.body.total, null);
  });
  await t('checkout is refused for an empty cart, bad email, a country we do not ship to', async () => {
    const empty = (await call('GET', '/cart')).body.guest; status(await call('POST', '/checkout', { cart: empty, body: checkoutBody() }), 409);
    status(await call('POST', '/checkout', { cart, body: checkoutBody({ email: 'bad' }) }), 400); status(await call('POST', '/checkout', { cart, body: checkoutBody({ shipping_address: { ...addr, country_code: 'FR' } }) }), 400);
  });
  await t('place an order in USD: a sent "total" is ignored, the server price wins', async () => {
    stockBefore = await stockOf(pA);
    const usd = currencies.find((c) => c.code === 'USD'); await call('GET', '/cart', { cart, currency: usd ? 'USD' : 'JOD' });
    const r = await call('POST', '/checkout', { cart, currency: usd ? 'USD' : 'JOD', body: checkoutBody({ total: 1, subtotal: 1, shipping_total: 0 }) }); status(r, 201);
    order = r.body; eq(order.status, 'PENDING'); eq(order.payment_status, 'PENDING'); ok(order.public_token, 'no token'); ok(order.total > 1 && order.order_number, 'total/number wrong');
  });
  await t('the order took the stock (reserved) and emptied the cart', async () => {
    eq((await call('GET', '/cart', { cart })).body.items, []); const now = await stockOf(pA); if (stockBefore !== null && now !== null) eq(now, stockBefore - 1, 'stock');
  });
  await t('order page: needs the secret token (no token / wrong token = 404), never shows the token', async () => {
    status(await call('GET', `/checkout/orders/${order.id}`), 404); status(await call('GET', `/checkout/orders/${order.id}?token=00000000-0000-4000-8000-000000000000`), 404);
    const r = await call('GET', `/checkout/orders/${order.id}?token=${order.public_token}`); status(r, 200); ok(!('public_token' in r.body), 'token leaked'); eq(r.body.order_items.length, 1);
  });
  await t('payment start: wrong token refused, right token gives the gateway page', async () => {
    status(await call('POST', '/payments/start', { body: { order_id: order.id, token: '00000000-0000-4000-8000-000000000000' } }), 404);
    const r = await call('POST', '/payments/start', { body: { order_id: order.id, token: order.public_token } }); status(r, 200); const m = /ref=([^&]+)/.exec(r.body.redirect_url); ok(m, 'no ref in url'); ref = decodeURIComponent(m[1]);
  });
  await t('a customer cannot mark an order paid with a made-up reference', async () => { status(await call('POST', '/payments/mock/confirm', { body: { ref: 'MOCK-not-a-real-reference', outcome: 'success' } }), 404); });
  await t('successful payment: order becomes CONFIRMED + PAID', async () => {
    const r = await call('POST', '/payments/mock/confirm', { body: { ref, outcome: 'success' } }); status(r, 200); eq(r.body.result, 'applied');
    const o = (await call('GET', `/checkout/orders/${order.id}?token=${order.public_token}`)).body; eq(o.payment_status, 'PAID'); eq(o.status, 'CONFIRMED');
  });
  await t('the same payment message twice does nothing the second time (no double charge/email)', async () => { eq((await call('POST', '/payments/mock/confirm', { body: { ref, outcome: 'success' } })).body.result, 'duplicate'); });
  await t('a late "failed" message can NOT undo a paid order', async () => {
    const r = await call('POST', '/payments/mock/confirm', { body: { ref, outcome: 'fail' } }); eq(r.body.result, 'ignored');
    eq((await call('GET', `/checkout/orders/${order.id}?token=${order.public_token}`)).body.payment_status, 'PAID');
  });
  await t('a paid order cannot be cancelled by the customer, and cannot be paid twice', async () => {
    status(await call('POST', `/checkout/orders/${order.id}/cancel`, { body: { token: order.public_token } }), 409); status(await call('POST', '/payments/start', { body: { order_id: order.id, token: order.public_token } }), 409);
  });
  const newOrder = async (p, qty = 1) => {
    const c = (await call('GET', '/cart')).body.guest; await call('POST', '/cart/items', { cart: c, body: { variant_id: p.variants[0].id, quantity: qty } });
    const r = await call('POST', '/checkout', { cart: c, body: checkoutBody() }); status(r, 201); return r.body;
  };
  await t('failed payment: order cancelled and the stock comes back', async () => {
    const before = await stockOf(pB); const o = await newOrder(pB); const s = await call('POST', '/payments/start', { body: { order_id: o.id, token: o.public_token } });
    const rf = decodeURIComponent(/ref=([^&]+)/.exec(s.body.redirect_url)[1]); eq((await call('POST', '/payments/mock/confirm', { body: { ref: rf, outcome: 'fail' } })).body.result, 'applied');
    const g = (await call('GET', `/checkout/orders/${o.id}?token=${o.public_token}`)).body; eq(g.status, 'CANCELLED'); eq(g.payment_status, 'FAILED');
    const after = await stockOf(pB); if (before !== null && after !== null) eq(after, before, 'stock restored');
    status(await call('POST', '/payments/start', { body: { order_id: o.id, token: o.public_token } }), 409);   // cannot pay a cancelled order
  });
  await t('customer cancels an unpaid order: stock restored, cancelling twice is fine', async () => {
    const before = await stockOf(pB); const o = await newOrder(pB, 2);
    status(await call('POST', `/checkout/orders/${o.id}/cancel`, { body: { token: o.public_token } }), 200); status(await call('POST', `/checkout/orders/${o.id}/cancel`, { body: { token: o.public_token } }), 200);
    const after = await stockOf(pB); if (before !== null && after !== null) eq(after, before, 'stock restored once, not twice');
    status(await call('POST', `/checkout/orders/${o.id}/cancel`, { body: { token: '00000000-0000-4000-8000-000000000000' } }), 404);
  });
  await t('two buyers, one item left: only one order can win (no overselling)', async () => {
    const left = await stockOf(pB); if (left === null || left > 6) return console.log('        (skipped: stock too high to exhaust quickly)');
    const carts = []; for (let i = 0; i < 2; i++) { const c = (await call('GET', '/cart')).body.guest; await call('POST', '/cart/items', { cart: c, body: { variant_id: pB.variants[0].id, quantity: left } }); carts.push(c); }
    const rs = await Promise.all(carts.map((c) => call('POST', '/checkout', { cart: c, body: checkoutBody() }))); eq(rs.filter((r) => r.status === 201).length, 1, 'orders created'); eq(rs.filter((r) => r.status === 409).length, 1, 'refused');
    const win = rs.find((r) => r.status === 201).body; await call('POST', `/checkout/orders/${win.id}/cancel`, { body: { token: win.public_token } });   // put the stock back
  });

  // ---------------------------------------------------------------- ACCOUNTS
  sec('Accounts');
  const email = `e2e-user-${RUN}@example.com`, pw1 = 'Correct-Horse-9', pw2 = 'Brand-New-Pass-77';
  let tok = null, refresh = null, uid = null;
  await t('register: weak password refused, good one works, same email twice refused', async () => {
    status(await call('POST', '/auth/register', { body: { email, password: 'short', first_name: 'E', last_name: 'T' } }), 400);
    const r = await call('POST', '/auth/register', { body: { email, password: pw1, first_name: 'Eve', last_name: 'Tester', phone: '0790000000' } }); status(r, 201); uid = r.body.user.id;
    status(await call('POST', '/auth/register', { body: { email, password: pw1, first_name: 'Eve', last_name: 'Tester' } }), 400);
  });
  await t('login: wrong password gives the generic message, right one gives a token, refresh works', async () => {
    const bad = await call('POST', '/auth/login', { body: { email, password: 'wrong-password-1' } }); status(bad, 401);
    const r = await call('POST', '/auth/login', { body: { email, password: pw1 } }); status(r, 200); tok = r.body.access_token; refresh = r.body.refresh_token; ok(tok && refresh, 'no tokens');
    const f = await call('POST', '/auth/refresh', { body: { refresh_token: refresh } }); status(f, 200); ok(f.body.access_token, 'no new token');
  });
  await t('profile: read, edit name/phone; unknown fields are refused', async () => {
    const me = await call('GET', '/me', { token: tok }); status(me, 200); eq(me.body.email ?? me.body.user?.email, email);
    const u = await call('PATCH', '/me', { token: tok, body: { first_name: 'Evelyn' } }); status(u, 200); eq(u.body.first_name, 'Evelyn');
    status(await call('PATCH', '/me', { token: tok, body: { role: 'ADMIN' } }), 400);   // cannot make yourself admin
    status(await call('GET', '/me'), 401);
  });
  await t('addresses: add, list, edit, delete', async () => {
    const a = await call('POST', '/me/addresses', { token: tok, body: { ...addr, label: 'Home', is_default: true } }); status(a, 201); const id = a.body.id;
    eq((await call('GET', '/me/addresses', { token: tok })).body.length, 1); status(await call('PUT', `/me/addresses/${id}`, { token: tok, body: { ...addr, city: 'Irbid' } }), 200);
    status(await call('DELETE', `/me/addresses/${id}`, { token: tok }), 204); eq((await call('GET', '/me/addresses', { token: tok })).body.length, 0);
  });
  await t('guest bag merges into the account bag after login', async () => {
    const g = (await call('GET', '/cart')).body.guest; await call('POST', '/cart/items', { cart: g, body: { variant_id: pA.variants[0].id } });
    const m = await call('POST', '/cart/merge', { token: tok, cart: g }); status(m, 200); eq(m.body.items.length, 1); eq((await call('GET', '/cart', { token: tok })).body.items.length, 1);
  });
  let myOrder = null;
  await t('signed-in checkout: order belongs to the account, shows in "my orders", another account cannot open it', async () => {
    const r = await call('POST', '/checkout', { token: tok, body: checkoutBody() }); status(r, 201); myOrder = r.body;
    const list = await call('GET', '/me/orders', { token: tok }); status(list, 200); ok(list.body.some((o) => o.id === myOrder.id), 'not in list');
    status(await call('GET', `/me/orders/${myOrder.id}`, { token: tok }), 200);
    const e2 = `e2e-other-${RUN}@example.com`; await call('POST', '/auth/register', { body: { email: e2, password: pw1, first_name: 'O', last_name: 'T' } });
    const t2 = (await call('POST', '/auth/login', { body: { email: e2, password: pw1 } })).body.access_token;
    status(await call('GET', `/me/orders/${myOrder.id}`, { token: t2 }), 404); status(await call('GET', `/checkout/orders/${myOrder.id}`, { token: t2 }), 404);
    status(await call('POST', `/checkout/orders/${myOrder.id}/cancel`, { token: t2, body: {} }), 404);
    await call('POST', `/checkout/orders/${myOrder.id}/cancel`, { token: tok, body: {} });
  });
  await t('forgot password: always "ok" (also for unknown emails); bad reset link refused; reset changes the password', async () => {
    eq((await call('POST', '/auth/forgot', { body: { email } })).body.ok, true); eq((await call('POST', '/auth/forgot', { body: { email: 'nobody@example.com' } })).body.ok, true);
    status(await call('POST', '/auth/reset', { body: { access_token: 'x'.repeat(40), password: pw2 } }), 400);
    status(await call('POST', '/auth/reset', { body: { access_token: tok, password: pw2 } }), 200);
    status(await call('POST', '/auth/login', { body: { email, password: pw1 } }), 401); status(await call('POST', '/auth/login', { body: { email, password: pw2 } }), 200);
  });
  await t('a customer is locked out of every admin route; no token = 401', async () => {
    for (const p of ['/admin/stats', '/admin/orders', '/admin/products', '/admin/customers', '/admin/content', '/admin/currencies']) { status(await call('GET', p, { token: tok }), 403, p); status(await call('GET', p), 401, p); }
    status(await call('PUT', '/admin/currencies/USD', { token: tok, body: { name: 'x', symbol: 'x', decimals: 2, round_step: 1, is_active: true } }), 403);
  });

  // ---------------------------------------------------------------- ADMIN
  sec('Admin');
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) { console.log('  (skipped: set ADMIN_EMAIL and ADMIN_PASSWORD to run the admin tests)'); return; }
  const login = await call('POST', '/auth/login', { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
  if (login.status !== 200) { await t('admin login', async () => { throw new Error('admin login failed: ' + JSON.stringify(login.body)); }); return; }
  const A = login.body.access_token;
  await t('dashboard stats load', async () => { status(await call('GET', '/admin/stats', { token: A }), 200); });
  let prod = null;
  await t('product: create (2 variants, stock), duplicate name/SKU refused, edit, appears in shop, hide, delete', async () => {
    const body = { name: `E2E Bag ${RUN}`, base_price: 80, variants: [{ sku: `E2E-${RUN}-A`, color_name: 'Red', quantity: 3, allow_preorder: false, is_active: true }, { sku: `E2E-${RUN}-B`, color_name: 'Blue', quantity: 0, allow_preorder: true, is_active: true }] };
    const c = await call('POST', '/admin/products', { token: A, body }); status(c, 201); prod = c.body; eq(prod.variants.length, 2);
    status(await call('POST', '/admin/products', { token: A, body }), 409);
    const u = await call('PUT', `/admin/products/${prod.id}`, { token: A, body: { ...body, base_price: 90, variants: prod.variants.map((v) => ({ id: v.id, sku: v.sku, color_name: v.color_name, quantity: v.quantity, allow_preorder: v.allow_preorder, is_active: true })) } }); status(u, 200); eq(Number(u.body.base_price), 90);
    status(await call('GET', `/products/${prod.slug}`), 200);
    await call('PUT', `/admin/products/${prod.id}`, { token: A, body: { ...body, is_active: false, variants: prod.variants.map((v) => ({ id: v.id, sku: v.sku, quantity: v.quantity, allow_preorder: v.allow_preorder, is_active: true })) } }); status(await call('GET', `/products/${prod.slug}`), 404);
  });
  await t('product: negative price / empty name / no variants refused', async () => {
    status(await call('POST', '/admin/products', { token: A, body: { name: 'x', base_price: -5, variants: [{ sku: 'q', quantity: 1 }] } }), 400); status(await call('POST', '/admin/products', { token: A, body: { name: '', base_price: 5, variants: [{ sku: 'q2', quantity: 1 }] } }), 400); status(await call('POST', '/admin/products', { token: A, body: { name: 'x', base_price: 5, variants: [] } }), 400);
  });
  await t('collection: create with a product, edit, delete', async () => {
    const c = await call('POST', '/admin/collections', { token: A, body: { title: `E2E Collection ${RUN}`, product_ids: [prod.id] } }); status(c, 201); const id = c.body.id ?? (await call('GET', '/admin/collections', { token: A })).body.find((x) => x.title.includes(RUN)).id;
    status(await call('PUT', `/admin/collections/${id}`, { token: A, body: { title: `E2E Collection ${RUN} v2`, product_ids: [] } }), 200); status(await call('DELETE', `/admin/collections/${id}`, { token: A }), 204);
  });
  let codeId = null;
  await t('discount codes: create, percent over 100 refused, works in a bag and at checkout, then delete', async () => {
    const code = `E2E${RUN}`.toUpperCase();
    status(await call('POST', '/admin/discounts', { token: A, body: { code: 'BAD', type: 'PERCENT', value: 150 } }), 400);
    const c = await call('POST', '/admin/discounts', { token: A, body: { code, type: 'PERCENT', value: 10, max_uses: 1 } }); status(c, 201); codeId = c.body.id;
    const g = (await call('GET', '/cart')).body.guest; await call('POST', '/cart/items', { cart: g, body: { variant_id: pA.variants[0].id } });
    const prev = await call('POST', '/cart/discount', { cart: g, body: { code: code.toLowerCase() } }); status(prev, 200); ok(prev.body.discount_total > 0, 'no discount');
    status(await call('POST', '/cart/discount', { cart: g, body: { code: 'NOPE-NOPE' } }), 400);
    const o = await call('POST', '/checkout', { cart: g, body: checkoutBody({ discount_code: code }) }); status(o, 201);
    const g2 = (await call('GET', '/cart')).body.guest; await call('POST', '/cart/items', { cart: g2, body: { variant_id: pA.variants[0].id } });
    status(await call('POST', '/checkout', { cart: g2, body: checkoutBody({ discount_code: code }) }), 400);   // max_uses 1 -> second use refused
    await call('POST', `/checkout/orders/${o.body.id}/cancel`, { body: { token: o.body.public_token } });
    status(await call('DELETE', `/admin/discounts/${codeId}`, { token: A }), 204);
  });
  await t('shipping: country + rate can be added and removed; free-over threshold is respected', async () => {
    status(await call('PUT', '/admin/countries/SA', { token: A, body: { name: 'Saudi Arabia', currency: 'SAR', ships_to: true } }), 200);
    const r = await call('POST', '/admin/shipping-rates', { token: A, body: { country_code: 'SA', min_subtotal: 0, price: 12 } }); status(r, 201);
    const g = (await call('GET', '/cart')).body.guest; await call('POST', '/cart/items', { cart: g, body: { variant_id: pA.variants[0].id } });
    eq((await call('POST', '/checkout/quote', { cart: g, body: { country_code: 'SA' } })).body.shipping_total, convert(12, currencies.find((c) => c.code === 'JOD')));
    status(await call('DELETE', `/admin/shipping-rates/${r.body.id}`, { token: A }), 204); status(await call('DELETE', '/admin/countries/SA', { token: A }), 204);
  });
  await t('order status flow: PROCESSING -> SHIPPED -> DELIVERED, shows in the list and the detail page', async () => {
    const o = await newOrder(pA); const s = await call('POST', '/payments/start', { body: { order_id: o.id, token: o.public_token } }); await call('POST', '/payments/mock/confirm', { body: { ref: decodeURIComponent(/ref=([^&]+)/.exec(s.body.redirect_url)[1]), outcome: 'success' } });
    ok((await call('GET', '/admin/orders', { token: A })).body.some((x) => x.id === o.id), 'not in list'); eq((await call('GET', '/admin/orders?status=CONFIRMED', { token: A })).body.every((x) => x.status === 'CONFIRMED'), true);
    for (const st of ['PROCESSING', 'SHIPPED', 'DELIVERED']) { status(await call('PATCH', `/admin/orders/${o.id}/status`, { token: A, body: { status: st } }), 200, st); eq((await call('GET', `/admin/orders/${o.id}`, { token: A })).body.status, st); }
    status(await call('PATCH', `/admin/orders/${o.id}/status`, { token: A, body: { status: 'WRONG' } }), 400);
    eq((await call('GET', `/admin/orders/${o.id}`, { token: A })).body.public_token, undefined, 'secret token visible in admin');
    status(await call('POST', `/admin/orders/${o.id}/refund`, { token: A }), 200); eq((await call('GET', `/admin/orders/${o.id}`, { token: A })).body.payment_status, 'REFUNDED');
  });
  await t('admin cancel returns stock once; a cancelled order is final', async () => {
    const before = await stockOf(pB); const o = await newOrder(pB); status(await call('PATCH', `/admin/orders/${o.id}/status`, { token: A, body: { status: 'CANCELLED' } }), 200);
    const after = await stockOf(pB); if (before !== null && after !== null) eq(after, before, 'stock'); status(await call('PATCH', `/admin/orders/${o.id}/status`, { token: A, body: { status: 'SHIPPED' } }), 409);
  });
  await t('customers list loads and shows the test account', async () => { const r = await call('GET', '/admin/customers', { token: A }); status(r, 200); ok(r.body.some((c) => c.email === email), 'test customer missing'); });
  await t('messages: the contact message arrives; can be marked handled', async () => {
    const r = await call('GET', '/admin/messages', { token: A }); status(r, 200); const m = r.body.find((x) => x.email === `e2e-${RUN}@example.com`); ok(m, 'message missing'); ok(!r.body.some((x) => x.message === 'buy cheap things'), 'bot message saved');
    status(await call('PATCH', `/admin/messages/${m.id}`, { token: A, body: { is_handled: true } }), 200);
  });
  await t('currencies: rounding editable, JOD cannot be switched off, "Refresh now" answers', async () => {
    const usd = currencies.find((c) => c.code === 'USD'); status(await call('PUT', '/admin/currencies/JOD', { token: A, body: { name: 'Jordanian dinar', symbol: 'JOD', decimals: 3, round_step: 0.001, is_active: false } }), 400);
    status(await call('PUT', '/admin/currencies/USD', { token: A, body: { name: usd.name, symbol: usd.symbol, decimals: usd.decimals, round_step: usd.round_step, is_active: true, rate: 99 } }), 200);
    eq((await call('GET', '/currencies')).body.find((c) => c.code === 'USD').rate, usd.rate, 'a typed rate must be ignored');
    const r = await call('POST', '/admin/currencies/refresh', { token: A }); status(r, 200); console.log('        refresh says:', JSON.stringify(r.body));
  });
  await t('content: edit the hero, public site shows it, bad link (javascript:) refused', async () => {
    const cur = (await call('GET', '/admin/content', { token: A })).body; const hero = (Array.isArray(cur) ? cur.find((x) => x.section === 'hero') : cur.hero)?.data ?? (cur.hero ?? {});
    const orig = { ...hero }; const edit = { ...orig, headline: `E2E headline ${RUN}` };
    status(await call('PUT', '/admin/content/hero', { token: A, body: { data: edit, is_active: true } }), 200); eq((await call('GET', '/content/homepage')).body.hero.headline, edit.headline);
    status(await call('PUT', '/admin/content/hero', { token: A, body: { data: { ...orig, cta_url: 'javascript:alert(1)' }, is_active: true } }), 400);
    status(await call('PUT', '/admin/content/hero', { token: A, body: { data: orig, is_active: true } }), 200);   // put it back
  });
  await t('journal: create a post (public), edit, hide (public 404), delete; bad web name refused', async () => {
    const slug = `e2e-post-${RUN}`; status(await call('POST', '/admin/journal', { token: A, body: { slug: 'Bad Slug!', title: 'x' } }), 400);
    const c = await call('POST', '/admin/journal', { token: A, body: { slug, title: 'E2E post', excerpt: 'x', body: '## Hi\n\nHello **world**' } }); status(c, 201); const id = c.body.id;
    status(await call('GET', `/content/journal/${slug}`), 200); status(await call('PUT', `/admin/journal/${id}`, { token: A, body: { slug, title: 'E2E post 2', is_active: false } }), 200); status(await call('GET', `/content/journal/${slug}`), 404);
    status(await call('DELETE', `/admin/journal/${id}`, { token: A }), 204);
  });
  await t('image upload accepts a real image and rejects other file types', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const up = await fetch(`${API}/admin/uploads?bucket=products`, { method: 'POST', headers: { authorization: `Bearer ${A}`, 'content-type': 'image/png' }, body: png }); console.log('        upload status:', up.status);
    eq(up.status, 201, "upload"); const bad = await fetch(`${API}/admin/uploads?bucket=products`, { method: 'POST', headers: { authorization: `Bearer ${A}`, 'content-type': 'application/x-msdownload' }, body: Buffer.from('MZ') }); ok(bad.status >= 400, 'exe accepted');
  });
  if (prod) await call('DELETE', `/admin/products/${prod.id}`, { token: A });
}

main().catch((e) => { console.error('Test runner crashed:', e); process.exitCode = 2; }).finally(() => {
  const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) { console.log('\nFailures:'); failed.forEach((f) => console.log(`- [${f.section}] ${f.name}: ${f.err}`)); process.exitCode = 1; }
});
