-- MULTI-CURRENCY. Product, shipping and discount amounts are stored in JOD (the base currency). Customers can browse and pay in
-- any ACTIVE currency below. rate = how many units of that currency equal 1 JOD. The converted price is rounded to round_step
-- (e.g. step 1 -> whole dollars). Every order remembers the rate used (fx_rate), so reports and refunds stay correct later.
create table currencies (
  code char(3) primary key, name text not null, symbol text not null,
  rate numeric(14,6) not null check (rate > 0),
  decimals int not null default 2 check (decimals between 0 and 3),
  round_step numeric(10,3) not null default 1 check (round_step > 0),
  is_active boolean not null default true, sort_order int not null default 0,
  updated_at timestamptz not null default now()
);
alter table currencies enable row level security;
create policy pub_currencies on currencies for select using (is_active);
create trigger currencies_updated before update on currencies for each row execute function set_updated_at();
alter table orders add column fx_rate numeric(14,6) not null default 1;   -- JOD amount = total / fx_rate

-- STARTING VALUES (the owner sets the real ones in Admin > Settings). USD and AED are fixed to the dollar; EUR floats (approximate).
insert into currencies(code,name,symbol,rate,decimals,round_step,sort_order) values
 ('JOD','Jordanian dinar','JOD',1,3,0.001,0),
 ('USD','US dollar','$',1.410437,2,1,1),
 ('EUR','Euro','€',1.21,2,1,2),
 ('AED','UAE dirham','AED',5.179831,2,1,3);

-- The ONE conversion rule (the server code uses the identical formula for display).
create function convert_price(p_base numeric, p_rate numeric, p_step numeric, p_dec int) returns numeric
language sql immutable set search_path = public as $$ select round(round(p_base * p_rate / p_step) * p_step, p_dec) $$;

-- Order creation, now currency-aware: prices, fixed discounts and thresholds are converted exactly as above.
create or replace function create_order_from_cart(
  p_cart_id uuid, p_email text, p_phone text, p_shipping jsonb, p_billing jsonb,
  p_discount_code text, p_shipping_total numeric
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_cart carts; r record; v_order uuid; v_subtotal numeric := 0; v_base_subtotal numeric := 0; v_disc numeric := 0;
  v_code discount_codes; v_pre boolean := false; v_base numeric; v_price numeric; v_img text;
  v_rate numeric; v_step numeric; v_dec int;
begin
  select * into v_cart from carts where id = p_cart_id;
  if not found then raise exception 'CART_NOT_FOUND'; end if;
  if not exists (select 1 from cart_items where cart_id = p_cart_id) then raise exception 'CART_EMPTY'; end if;
  select rate, round_step, decimals into v_rate, v_step, v_dec from currencies where code = v_cart.currency and is_active;
  if not found then raise exception 'CURRENCY_UNAVAILABLE'; end if;

  insert into orders(user_id, email, phone, currency, fx_rate, subtotal, total, shipping_address, billing_address)
  values (v_cart.user_id, p_email, p_phone, v_cart.currency, v_rate, 0, 0, p_shipping, p_billing)
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
      if r.allow_preorder then v_pre := true;
      else raise exception 'OUT_OF_STOCK:%', r.name; end if;
    end if;
    v_base := coalesce(r.price_override, r.base_price);                 -- JOD price from the DB, never from the client
    v_price := convert_price(v_base, v_rate, v_step, v_dec);             -- the customer's currency
    select url into v_img from product_images where product_id = r.product_id order by sort_order limit 1;
    insert into order_items(order_id, product_id, variant_id, product_name, variant_label, sku, unit_price, quantity, line_total, image_url)
    values (v_order, r.product_id, r.variant_id, r.name, r.color_name, r.sku, v_price, r.quantity, v_price * r.quantity, v_img);
    v_subtotal := v_subtotal + v_price * r.quantity;
    v_base_subtotal := v_base_subtotal + v_base * r.quantity;
    update inventory set quantity = greatest(quantity - r.quantity, 0) where variant_id = r.variant_id;
  end loop;

  if p_discount_code is not null and p_discount_code <> '' then
    select * into v_code from discount_codes where code = upper(p_discount_code) for update;
    if not found or not v_code.is_active
       or (v_code.starts_at is not null and v_code.starts_at > now())
       or (v_code.expires_at is not null and v_code.expires_at < now())
       or (v_code.max_uses is not null and v_code.used_count >= v_code.max_uses)
       or v_base_subtotal < v_code.min_subtotal then raise exception 'INVALID_DISCOUNT'; end if;   -- thresholds are in JOD
    v_disc := least(v_subtotal, case v_code.type when 'PERCENT' then round(v_subtotal * v_code.value / 100, v_dec)
                                else convert_price(v_code.value, v_rate, v_step, v_dec) end);       -- fixed amounts are JOD, converted
    update discount_codes set used_count = used_count + 1 where id = v_code.id;
  end if;

  update orders set subtotal = v_subtotal, discount_total = v_disc, shipping_total = p_shipping_total,
         total = v_subtotal - v_disc + p_shipping_total, discount_code = upper(nullif(p_discount_code,'')), is_preorder = v_pre
  where id = v_order;
  delete from cart_items where cart_id = p_cart_id;
  return v_order;
end $$;
revoke execute on function create_order_from_cart(uuid,text,text,jsonb,jsonb,text,numeric) from public, anon, authenticated;
