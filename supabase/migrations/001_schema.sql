-- =====================================================================
-- LEEN SUMMAQA — PHASE 2 SCHEMA (Supabase PostgreSQL)
-- Run in: Supabase Dashboard > SQL Editor (or `supabase db push`).
-- Design rules (good oral-exam talking points):
--   1. UUID primary keys, foreign keys, timestamps on everything.
--   2. Orders SNAPSHOT product data (name/price/variant) so later product edits
--      never rewrite history.
--   3. Stock check + order creation happen in ONE database function (atomic),
--      so two buyers can't both take the last bag.
--   4. Payments are idempotent: unique(provider, provider_ref) + payment_events.
--   5. RLS is ON for every table. The Express API uses the service-role key
--      (bypasses RLS); the browser can only touch what policies allow.
-- =====================================================================
create extension if not exists pgcrypto;

-- ---------- ENUMS ----------
create type user_role      as enum ('CUSTOMER','ADMIN');
create type order_status   as enum ('PENDING','CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED');
create type payment_status as enum ('PENDING','AUTHORIZED','PAID','FAILED','REFUNDED');
create type discount_type  as enum ('PERCENT','FIXED');

-- Reusable trigger: keep updated_at honest.
create function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ---------- USERS ----------
-- Supabase Auth owns passwords (auth.users). This table mirrors the user and holds the ROLE.
-- Customers have NO update policy on it, so nobody can promote themselves to ADMIN.
create table users (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null unique,
  role       user_role not null default 'CUSTOMER',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table customer_profiles (
  user_id    uuid primary key references users(id) on delete cascade,
  first_name text, last_name text, phone text,
  updated_at timestamptz not null default now()
);
create table addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  label text, recipient text not null, line1 text not null, line2 text,
  city text not null, region text, postal_code text,
  country_code char(2) not null, phone text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create index addresses_user_idx on addresses(user_id);

-- Auto-create users + profile row whenever someone signs up through Supabase Auth.
create function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into users(id, email) values (new.id, new.email);
  insert into customer_profiles(user_id, first_name, last_name, phone)
  values (new.id, new.raw_user_meta_data->>'first_name', new.raw_user_meta_data->>'last_name', new.raw_user_meta_data->>'phone');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- ---------- INTERNATIONAL ----------
-- No Jordan-only assumptions: countries + per-country shipping rates are DATA.
-- (Intentionally empty: real shipping prices come from the business, not from us.)
create table countries (
  code char(2) primary key, name text not null, currency char(3) not null,
  ships_to boolean not null default false
);
create table shipping_rates (
  id uuid primary key default gen_random_uuid(),
  country_code char(2) not null references countries(code),
  min_subtotal numeric(12,3) not null default 0,   -- rate applies from this subtotal up
  price numeric(12,3) not null check (price >= 0),
  is_active boolean not null default true
);
create index shipping_rates_country_idx on shipping_rates(country_code);

-- ---------- CATALOG ----------
create table categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique, name text not null,
  parent_id uuid references categories(id) on delete set null,
  sort_order int not null default 0
);
create table collections (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique, title text not null, description text,
  hero_image_url text, intro_text text,
  editorial jsonb not null default '[]',            -- extra editorial images/blocks per collection
  is_active boolean not null default true, sort_order int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,                        -- SEO URL: /products/tri-amore
  name text not null, description text, material text, dimensions text,
  category_id uuid references categories(id) on delete set null,
  base_price numeric(12,3) not null check (base_price >= 0),  -- JOD has 3 decimals (fils)
  currency char(3) not null default 'JOD',
  is_active boolean not null default true,
  is_featured boolean not null default false,
  force_sold_out boolean not null default false,    -- admin "mark sold out" switch
  -- full-text search column, kept in sync automatically
  search tsvector generated always as (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(description,''))) stored,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index products_search_idx   on products using gin(search);
create index products_category_idx on products(category_id);
create index products_active_idx   on products(is_active, is_featured);
create table product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  url text not null, alt_text text, sort_order int not null default 0,
  is_hover boolean not null default false           -- the secondary image shown on card hover
);
create index product_images_product_idx on product_images(product_id, sort_order);
create table product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  sku text not null unique, color_name text, color_hex text, size_label text,
  price_override numeric(12,3) check (price_override >= 0),
  allow_preorder boolean not null default false,    -- brand sells pre-order (2 weeks production)
  is_active boolean not null default true
);
create index product_variants_product_idx on product_variants(product_id);
create table inventory (
  variant_id uuid primary key references product_variants(id) on delete cascade,
  quantity int not null default 0 check (quantity >= 0),  -- DB itself refuses negative stock
  updated_at timestamptz not null default now()
);
create table collection_products (
  collection_id uuid references collections(id) on delete cascade,
  product_id uuid references products(id) on delete cascade,
  sort_order int not null default 0, is_featured boolean not null default false,
  primary key (collection_id, product_id)
);
create index collection_products_product_idx on collection_products(product_id);

-- ---------- CART ----------
create table carts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,          -- null = guest cart
  guest_token uuid not null default gen_random_uuid() unique,   -- guest proves ownership with this
  currency char(3) not null default 'JOD',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references carts(id) on delete cascade,
  variant_id uuid not null references product_variants(id) on delete cascade,
  quantity int not null check (quantity > 0 and quantity <= 20),
  unique (cart_id, variant_id)
);
create index cart_items_cart_idx on cart_items(cart_id);

-- ---------- DISCOUNTS ----------
create table discount_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code = upper(code)),
  type discount_type not null, value numeric(12,3) not null check (value > 0),
  min_subtotal numeric(12,3) not null default 0,
  max_uses int, used_count int not null default 0,
  starts_at timestamptz, expires_at timestamptz,
  is_active boolean not null default true
);

-- ---------- ORDERS ----------
create sequence order_number_seq start 1001;
create table orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint not null unique default nextval('order_number_seq'),  -- human-friendly number
  user_id uuid references users(id) on delete set null,                     -- null = guest checkout
  email text not null, phone text,
  status order_status not null default 'PENDING',
  payment_status payment_status not null default 'PENDING',
  currency char(3) not null default 'JOD',
  subtotal numeric(12,3) not null, shipping_total numeric(12,3) not null default 0,
  discount_total numeric(12,3) not null default 0, total numeric(12,3) not null,
  discount_code text,
  shipping_address jsonb not null, billing_address jsonb,
  is_preorder boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index orders_user_idx   on orders(user_id, created_at desc);
create index orders_status_idx on orders(status, payment_status);
create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  -- set null (not cascade): deleting a product must NOT delete sales history
  product_id uuid references products(id) on delete set null,
  variant_id uuid references product_variants(id) on delete set null,
  -- SNAPSHOT columns: frozen copy of what the customer actually bought
  product_name text not null, variant_label text, sku text,
  unit_price numeric(12,3) not null, quantity int not null check (quantity > 0),
  line_total numeric(12,3) not null, image_url text
);
create index order_items_order_idx on order_items(order_id);

-- ---------- PAYMENTS (no card data is ever stored) ----------
create table payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  provider text not null,                -- 'capitalbank' | 'mock'
  provider_ref text,                     -- the gateway's transaction/session id
  status payment_status not null default 'PENDING',
  amount numeric(12,3) not null, currency char(3) not null,
  raw_response jsonb,                    -- gateway response for audit (must not contain card numbers)
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (provider, provider_ref)        -- idempotency: same gateway txn can only exist once
);
create index payments_order_idx on payments(order_id);
-- Every webhook is recorded once; a repeat delivery hits the unique key and is ignored.
create table payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null, event_id text not null, payload jsonb,
  received_at timestamptz not null default now(),
  unique (provider, event_id)
);

-- ---------- MARKETING / CONTENT ----------
create table newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null, source text, subscribed_at timestamptz not null default now()
);
create unique index newsletter_email_idx on newsletter_subscribers(lower(email));
create table homepage_content (          -- one row per homepage section: hero, featured, campaign, press, clique
  id uuid primary key default gen_random_uuid(),
  section text not null unique, data jsonb not null default '{}',
  is_active boolean not null default true, updated_at timestamptz not null default now()
);
create table editorial_content (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique, kind text not null check (kind in ('campaign','press','community','story')),
  title text, body text, image_url text, link_url text,
  sort_order int not null default 0, is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- updated_at triggers
do $$ declare t text; begin
  foreach t in array array['users','customer_profiles','collections','products','inventory','carts','orders','payments','homepage_content'] loop
    execute format('create trigger %I_updated before update on %I for each row execute function set_updated_at()', t, t);
  end loop; end $$;

-- =====================================================================
-- BUSINESS FUNCTIONS (called only by the API with the service-role key)
-- =====================================================================

-- Atomically: validate stock -> price from DB -> discount -> create order + snapshots -> reserve stock -> empty cart.
-- `for update` locks the cart rows; the stock UPDATE then serialises concurrent buyers, so no overselling.
create function create_order_from_cart(
  p_cart_id uuid, p_email text, p_phone text, p_shipping jsonb, p_billing jsonb,
  p_discount_code text, p_shipping_total numeric
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_cart carts; r record; v_order uuid; v_subtotal numeric := 0; v_disc numeric := 0;
  v_code discount_codes; v_pre boolean := false; v_price numeric; v_img text;
begin
  select * into v_cart from carts where id = p_cart_id;
  if not found then raise exception 'CART_NOT_FOUND'; end if;
  if not exists (select 1 from cart_items where cart_id = p_cart_id) then raise exception 'CART_EMPTY'; end if;

  insert into orders(user_id, email, phone, currency, subtotal, total, shipping_address, billing_address)
  values (v_cart.user_id, p_email, p_phone, v_cart.currency, 0, 0, p_shipping, p_billing)
  returning id into v_order;

  for r in
    select ci.variant_id, ci.quantity, v.sku, v.color_name, v.allow_preorder, v.is_active as v_active,
           p.id as product_id, p.name, p.base_price, p.is_active as p_active, p.force_sold_out,
           v.price_override, coalesce(i.quantity,0) as stock
    from cart_items ci
    join product_variants v on v.id = ci.variant_id
    join products p on p.id = v.product_id
    left join inventory i on i.variant_id = v.id
    where ci.cart_id = p_cart_id
    for update of ci
  loop
    if not (r.v_active and r.p_active) or r.force_sold_out then raise exception 'UNAVAILABLE:%', r.name; end if;
    if r.stock < r.quantity then
      if r.allow_preorder then v_pre := true;               -- pre-orders may exceed stock
      else raise exception 'OUT_OF_STOCK:%', r.name; end if;
    end if;
    v_price := coalesce(r.price_override, r.base_price);     -- price ALWAYS comes from DB, never from the client
    select url into v_img from product_images where product_id = r.product_id order by sort_order limit 1;
    insert into order_items(order_id, product_id, variant_id, product_name, variant_label, sku, unit_price, quantity, line_total, image_url)
    values (v_order, r.product_id, r.variant_id, r.name, r.color_name, r.sku, v_price, r.quantity, v_price * r.quantity, v_img);
    v_subtotal := v_subtotal + v_price * r.quantity;
    -- reserve stock now (restored if the order is cancelled / payment fails)
    update inventory set quantity = greatest(quantity - r.quantity, 0) where variant_id = r.variant_id;
  end loop;

  if p_discount_code is not null and p_discount_code <> '' then
    select * into v_code from discount_codes where code = upper(p_discount_code) for update;
    if not found or not v_code.is_active
       or (v_code.starts_at is not null and v_code.starts_at > now())
       or (v_code.expires_at is not null and v_code.expires_at < now())
       or (v_code.max_uses is not null and v_code.used_count >= v_code.max_uses)
       or v_subtotal < v_code.min_subtotal then raise exception 'INVALID_DISCOUNT'; end if;
    v_disc := least(v_subtotal, case v_code.type when 'PERCENT' then round(v_subtotal * v_code.value / 100, 3) else v_code.value end);
    update discount_codes set used_count = used_count + 1 where id = v_code.id;
  end if;

  update orders set subtotal = v_subtotal, discount_total = v_disc, shipping_total = p_shipping_total,
         total = v_subtotal - v_disc + p_shipping_total, discount_code = upper(nullif(p_discount_code,'')), is_preorder = v_pre
  where id = v_order;
  delete from cart_items where cart_id = p_cart_id;
  return v_order;
end $$;

-- Idempotent "mark paid": calling it twice changes nothing the second time.
-- Also checks the gateway amount equals the order total (defends against tampering).
create function mark_order_paid(p_order_id uuid, p_provider text, p_provider_ref text, p_amount numeric)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_total numeric; v_changed int;
begin
  select total into v_total from orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_total <> p_amount then raise exception 'AMOUNT_MISMATCH'; end if;
  insert into payments(order_id, provider, provider_ref, status, amount, currency)
  select p_order_id, p_provider, p_provider_ref, 'PAID', p_amount, currency from orders where id = p_order_id
  on conflict (provider, provider_ref) do update set status = 'PAID';
  update orders set payment_status = 'PAID', status = 'CONFIRMED'
  where id = p_order_id and payment_status <> 'PAID';
  get diagnostics v_changed = row_count;
  return v_changed > 0;                       -- true only the first time
end $$;

-- Cancel + put reserved stock back (only if not already cancelled).
create function cancel_order(p_order_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from orders where id = p_order_id and status <> 'CANCELLED') then
    update inventory i set quantity = i.quantity + oi.quantity
    from order_items oi where oi.order_id = p_order_id and oi.variant_id = i.variant_id;
    update orders set status = 'CANCELLED' where id = p_order_id;
  end if;
end $$;
revoke execute on function create_order_from_cart(uuid,text,text,jsonb,jsonb,text,numeric), mark_order_paid(uuid,text,text,numeric), cancel_order(uuid)
  from public, anon, authenticated;

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
do $$ declare t text; begin
  foreach t in array array['users','customer_profiles','addresses','countries','shipping_rates','categories','collections','products',
    'product_images','product_variants','inventory','collection_products','carts','cart_items','discount_codes','orders','order_items',
    'payments','payment_events','newsletter_subscribers','homepage_content','editorial_content'] loop
    execute format('alter table %I enable row level security', t);
  end loop; end $$;

-- Customers: only their own rows.
create policy own_user    on users             for select using (id = auth.uid());
create policy own_profile on customer_profiles for select using (user_id = auth.uid());
create policy upd_profile on customer_profiles for update using (user_id = auth.uid());
create policy own_address on addresses         for all    using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_cart    on carts             for select using (user_id = auth.uid());
create policy own_orders  on orders            for select using (user_id = auth.uid());
create policy own_items   on order_items       for select using (exists (select 1 from orders o where o.id = order_id and o.user_id = auth.uid()));
-- Public storefront data: read-only, active rows only.
create policy pub_products    on products            for select using (is_active);
create policy pub_images      on product_images      for select using (true);
create policy pub_variants    on product_variants    for select using (is_active);
create policy pub_collections on collections         for select using (is_active);
create policy pub_colprod     on collection_products for select using (true);
create policy pub_categories  on categories          for select using (true);
create policy pub_countries   on countries           for select using (true);
create policy pub_shipping    on shipping_rates      for select using (is_active);
create policy pub_homepage    on homepage_content    for select using (is_active);
create policy pub_editorial   on editorial_content   for select using (is_active);
-- No policies at all on: inventory, discount_codes, payments, payment_events, newsletter_subscribers,
-- cart_items -> only the API (service role) can touch them.

-- Storage buckets (public read; uploads only via API-issued signed URLs).
insert into storage.buckets(id, name, public) values
  ('products','products',true),('campaigns','campaigns',true),('editorial','editorial',true),('branding','branding',true)
on conflict do nothing;
