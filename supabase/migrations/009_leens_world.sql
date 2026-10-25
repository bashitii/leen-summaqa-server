-- LEEN'S WORLD: the Journal (blog) + the intro and "as featured in" strip of the Leen's World page.
-- Journal posts live in their own table (title, excerpt, body, image, date). RLS is on with no policies: only the API (service role) touches it.
create table if not exists journal_posts (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null, excerpt text not null default '', body text not null default '', image_url text not null default '',
  published_at timestamptz not null default now(), is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table journal_posts enable row level security;
create trigger journal_posts_updated before update on journal_posts for each row execute function set_updated_at();

-- Page intro + the moving "as featured in" strip (logos are uploaded later in Admin > Content; until then the outlet names scroll).
insert into homepage_content(section,data) values
 ('world', jsonb_build_object('eyebrow','Leen''s World','headline','Inside the world of Leen','text','The story, the moments and the people behind the bags.','image_url','')),
 ('featured', jsonb_build_object('eyebrow','As featured in','logos',jsonb_build_array(),
   'outlets',jsonb_build_array('ET بالعربي','سيدتي','زهرة الخليج','Soigné Middle East','Harper''s Bazaar Arabia','Marie Claire Arabia','HIA','Marseille Provence Airport'),
   'review_note','Upload the real logos here (Admin > Content > As featured in). Until then the outlet names scroll instead.'))
on conflict (section) do nothing;

-- Two starter posts on the same topics as the posts on the old Shopify blog. Worded fresh: replace with the originals in Admin > Journal if preferred.
insert into journal_posts(slug,title,excerpt,body,published_at) values
('the-ultimate-gift-guide-for-the-stylish-arab-girl-in-your-life',
 'The Ultimate Gift Guide for the Stylish Arab Girl in Your Life',
 'Shopping for the friend with strong opinions about outfits and an eye for every detail? Start here.',
 $b$Every friend group has her: the one with strong opinions about outfits, a sharp eye for detail, and a bag that always looks like it was chosen on purpose. Buying for her can feel risky. This guide makes it easy.

## Start with the occasion

For **Eid**, go bold. The TRIRAFFIA is a geometric, handwoven raffia bag in a triangular shape, and it comes in Natural, Hot Pink, Navy and Lilac. It is a pre-order piece, so plan ahead.

For **Valentine's Day** or a birthday, the Mini Triangular is a compact, structured evening bag in Lilac, Baby Pink, Navy and Sky Blue. Small, striking and easy to love.

For **a summer birthday**, the Seashell Raffia in Sky Blue and White is light, playful and part of the limited Summer Edit.

For **a milestone**, such as a graduation or an anniversary, the Leila Raffia is our most elevated full-sized bag.

## Choose by personality

- The one who loves colour: TRIRAFFIA in Hot Pink or Lilac.
- The soft and romantic one: Mini Triangular in Baby Pink.
- The minimalist: a Navy piece, or Natural raffia.
- The one who has everything: something she has not seen yet, in a shape that makes people ask where it is from.

## Good to know

- Our bags are handmade, and we ship worldwide.
- Ordering for Eid or another special date? Place the order 7 to 10 days ahead.
- Want it gift wrapped? Email us and we will arrange the packaging.

Ready to choose? [Browse the full collection](/shop).$b$, '2026-05-17'),
('why-raffia-bags-are-everywhere-this-summer-and-where-to-get-the-best-one',
 'Why Raffia Bags Are Everywhere This Summer (and Where to Get the Best One)',
 'Raffia has moved from the beach to the runway, and across the Arab world. Here is why, and what to look for.',
 $b$From Aqaba and Amman to the runways of Milan, raffia has stopped being a beach accessory. It is now one of the most wanted bag materials of the season. Here is why it is everywhere, and how to choose a good one.

## What is raffia?

Raffia is a natural, plant-based fibre. It is biodegradable and needs no chemical tanning.

## Why everyone wants one

- **Texture is back.** After years of minimal, quiet luxury, people want pieces with character and a story.
- **Handmade matters.** Interest has moved from fast fashion toward things made by hand.
- **Summer colour.** Raffia takes dye beautifully, so bright pinks, lilacs and blues look rich rather than flat.
- **It photographs well.** The weave catches the light and looks great in pictures.

## How to choose a good raffia bag

- Look for a tight, even weave with no loose ends.
- Check that the handles are reinforced and comfortable to carry.
- Pick a shape that holds its form instead of sagging.
- Prefer makers who work by hand.

## Our pick

The TRIRAFFIA is our handwoven take on the trend: a bold triangular shape in natural and bright colours. [See it in the shop](/shop).

## Questions we hear often

**Is raffia durable?** Yes, when it is looked after and kept away from heavy rain.

**How do I care for it?** Keep it dry, spot clean gently and store it in a dust bag.

**Is it only for summer?** Raffia is strongest in warm months, but a Natural or Navy piece works much longer through the year.

**Is it sustainable?** The fibre is natural and biodegradable.$b$, '2026-05-17')
on conflict (slug) do nothing;
