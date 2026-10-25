-- DEV SEED: real product names/prices copied from leensummaqa.com.
-- Images and stock are NOT seeded (set real stock + upload photos in the admin).
-- Pre-order is only enabled on the item the live site marks "Pre-order".
insert into categories(slug,name) values ('bags','Bags'),('accessories','Accessories');
insert into products(slug,name,base_price,category_id,is_featured)
select s.slug, s.name, s.price, (select id from categories where slug=s.cat), s.feat from (values
 ('navy-mini-triangular-bag','Mini Triangular Bag in Navy',60,'bags',true),
 ('lilac-mini-triangular-bag','Mini Triangular Bag in Lilac',60,'bags',true),
 ('pink-mini-triangular-bag','Mini Triangular Bag in Baby Pink',60,'bags',true),
 ('blue-mini-triangular-bag','Mini Triangular Bag in Sky Blue',60,'bags',true),
 ('leila-bag','Leila Raffia Bag',150,'bags',false),
 ('tri-amore-in-lilac','Tri-Amore in Lilac',100,'bags',false),
 ('tristanbul-in-black','Black Tri-Istanbul Bag',500,'bags',false),
 ('diana-ii-bag','Diana II Bag',120,'bags',false),
 ('chilli-triangle-earring','Chilli Triangle Earring',70,'accessories',false)
) as s(slug,name,price,cat,feat);
insert into product_variants(product_id,sku,allow_preorder)
select id, upper(replace(slug,'-','_'))||'_DEFAULT', slug='blue-mini-triangular-bag' from products;
insert into inventory(variant_id,quantity) select id,0 from product_variants;
insert into countries(code,name,currency,ships_to) values ('JO','Jordan','JOD',true);

-- Collections (names taken from the live site's sections)
insert into collections(slug,title,sort_order) values ('mini-triangular','Mini Triangular',1),('the-summer-edit','The Summer Edit',2);
insert into collection_products(collection_id,product_id,sort_order)
select c.id,p.id,0 from collections c join products p on
 (c.slug='mini-triangular' and p.slug like '%mini-triangular-bag') or (c.slug='the-summer-edit' and p.slug='leila-bag');

-- More real products from the live site (safe to re-run)
insert into products(slug,name,base_price,category_id)
select s.slug, s.name, s.price, (select id from categories where slug='bags') from (values
 ('pink-mini-bag','Diana Bag',92),
 ('seashell-raffia-bag-in-sky-blue-white','Seashell Raffia Bag in Sky Blue & White',60),
 ('tri-raffia-bag-in-hot-pink','Tri-Raffia Bag in Hot Pink',120)
) as s(slug,name,price) where not exists (select 1 from products p where p.slug = s.slug);
insert into product_variants(product_id,sku)
select p.id, upper(replace(p.slug,'-','_'))||'_DEFAULT' from products p
where not exists (select 1 from product_variants v where v.product_id = p.id);
insert into inventory(variant_id,quantity)
select v.id,0 from product_variants v where not exists (select 1 from inventory i where i.variant_id = v.id);
insert into collection_products(collection_id,product_id,sort_order)
select c.id,p.id,0 from collections c join products p on c.slug='the-summer-edit' and p.slug in ('seashell-raffia-bag-in-sky-blue-white','tri-raffia-bag-in-hot-pink')
on conflict do nothing;
