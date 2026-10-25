-- EDITABLE SITE CONTENT (homepage sections + info pages). Everything here can be changed later in Admin > Content.
-- Wording comes from the live site (leensummaqa.com) or from the original brief. Privacy and Terms are DRAFTS (see review_note).
insert into homepage_content(section,data) values
 ('hero', jsonb_build_object('headline','Designed to stand out','cta_label','Shop the collection','cta_url','/shop','image_url','','video_url','')),
 ('featured_collection', jsonb_build_object('eyebrow','The Summer Edit','title','Leila Raffia Bag','text','Discover our latest collection featuring premium quality and modern handmade design.','collection_slug','the-summer-edit','image_url','','cta_label','Shop now','cta_url','/products/leila-bag')),
 ('campaign', jsonb_build_object('eyebrow','The Leen woman','headline','Confident. Individual. Unapologetic.','text','','image_url','','video_url','','cta_label','Shop the collection','cta_url','/collections/mini-triangular')),
 ('press', jsonb_build_object('eyebrow','Recognition','headline','Worn by Her Majesty Queen Rania on Independence Day.','text','Her Majesty Queen Rania Al Abdullah chose to celebrate Independence Day with our Mini Triangular bag.','image_url','','cta_label','Shop the bag','cta_url','/products/lilac-mini-triangular-bag','outlets',jsonb_build_array('Sayidaty','Marie Claire'))),
 ('story', jsonb_build_object('eyebrow','The House','headline','Art, carried every day.','image_url','','cta_label','Read the story','cta_url','/about','body',$b$Founded by Leen Abu Summaqa in 2019, the brand transforms bold geometric design, especially triangles, into standout handbags that blend art with everyday function.

Each piece reflects confidence and individuality, made for women who express, not blend in.$b$)),
 ('clique', jsonb_build_object('eyebrow','#Leenclique','headline','Join the #Leenclique','text','At Leen Summaqa we pride ourselves with our customers. You are the source of our inspiration and we curate all our pieces just for you! So share your Leen bag on Instagram and join the #Leenclique with the hashtag.','instagram_url','https://www.instagram.com/leensummaqa','images',jsonb_build_array())),
 ('newsletter', jsonb_build_object('headline','Enter the Leen world','text','Be the first to discover new collections, limited pieces and exclusive releases.')),

 ('page_about', jsonb_build_object('title','The House','image_url','','review_note','Built only from facts on the old site. Add the founder story, craftsmanship and brand journey in your own words.','body',$b$Founded by Leen Abu Summaqa in 2019, the brand transforms bold geometric design, especially triangles, into standout handbags that blend art with everyday function.

Each piece reflects confidence and individuality, made for women who express, not blend in.

Our bags are handcrafted in Egypt and Türkiye.

The brand was recognised regionally when Her Majesty Queen Rania Al Abdullah wore a signature design, and it continues to evolve with a modern, bold and unapologetically unique identity.$b$)),
 ('page_contact', jsonb_build_object('title','Contact','intro','For inquiries, email us at mgmt@leensummaqa.com','instagram_url','https://www.instagram.com/leensummaqa','facebook_url','https://www.facebook.com/leensummaqa')),
 ('page_faq', jsonb_build_object('title','FAQ','review_note','Only answers backed by the old site. Add more as customers ask.','items',jsonb_build_array(
   jsonb_build_object('q','Do you ship worldwide?','a','Yes, we ship worldwide. The shipping cost for your country is shown at checkout.'),
   jsonb_build_object('q','What does pre-order mean?','a','Some pieces are made to order. Pre-order: 2 weeks production + shipping time applies.'),
   jsonb_build_object('q','Where are your bags made?','a','Our bags are handcrafted in Egypt and Türkiye.'),
   jsonb_build_object('q','What is your return policy?','a','If you find a defect, you have 3 days after receiving your item to request a return. Please read the full [Returns policy](/returns).'),
   jsonb_build_object('q','How can I contact you?','a','Email us at mgmt@leensummaqa.com, or send a message from the [Contact page](/contact).'),
   jsonb_build_object('q','What is the #Leenclique?','a','It is our community. Share your Leen bag on Instagram with the hashtag #Leenclique.')))),
 ('page_shipping', jsonb_build_object('title','Shipping','review_note','The old site had no shipping policy. Add delivery times, carriers and any free-shipping rule once confirmed.','body',$b$We ship worldwide.

Shipping cost is calculated at checkout, based on your country.

Pre-order: 2 weeks production + shipping time applies.

Questions about your delivery? Email mgmt@leensummaqa.com.$b$)),
 ('page_returns', jsonb_build_object('title','Returns','review_note','Copied from the old Refund policy, which is a generic template. The return email there was another brand (shop-lyn.com); it was replaced with mgmt@leensummaqa.com, and info@leensummaqa.com is still mentioned below. Please confirm the correct email and review the rules (for example perishable goods do not apply to bags).','body',$b$If you have found a defect on your item, we have a 3-day return policy, which means you have 3 days after receiving your item to request a return.

To be eligible for a return, your item must be in the same condition that you received it, unworn or unused, with tags, and in its original packaging. You will also need the receipt or proof of purchase.

To start a return, you can contact us at mgmt@leensummaqa.com.

## Damages and issues
Please inspect your order upon reception and contact us immediately if the item is defective, damaged or if you receive the wrong item, so that we can evaluate the issue and make it right.

## Exceptions / non-returnable items
Certain types of items cannot be returned, like perishable goods (such as food, flowers, or plants), custom products (such as special orders or personalized items), and personal care goods (such as beauty products). We also do not accept returns for hazardous materials, flammable liquids, or gases. Please get in touch if you have questions or concerns about your specific item.

Unfortunately, we cannot accept returns on sale items or gift cards.

## Exchanges
The fastest way to ensure you get what you want is to return the item you have, and once the return is accepted, make a separate purchase for the new item.

## European Union 14 day cooling off period
If the merchandise is being shipped into the European Union, you have the right to cancel or return your order within 14 days, for any reason and without a justification. As above, your item must be in the same condition that you received it, unworn or unused, with tags, and in its original packaging. You will also need the receipt or proof of purchase.

## Refunds
We will notify you once we have received and inspected your return, and let you know if the refund was approved or not. If approved, you will be automatically refunded on your original payment method within 10 business days. Please remember it can take some time for your bank or credit card company to process and post the refund too.

If more than 15 business days have passed since we have approved your return, please contact us at info@leensummaqa.com.$b$)),
 ('page_privacy', jsonb_build_object('title','Privacy','review_note','DRAFT written from what the new site actually does. The old Shopify privacy policy named another website (shop-lyn.com), Shopify and Shopify Audiences, so it was NOT copied. Have this reviewed (and add any analytics or advertising tools you switch on) before launch.','body',$b$This page explains what information Leen Summaqa collects when you use this website and how it is used.

## What we collect
- Your name, email address and phone number when you create an account, place an order, or contact us.
- Your delivery and billing addresses and the details of your orders.
- Your email address if you subscribe to our newsletter.
- The messages you send us through the contact form.

## Payments
Card details are entered on our payment provider's secure page. We never see or store your card number.

## How we use it
To process and deliver your orders, take payment, keep your account, answer your messages, and, if you subscribe, tell you about new collections.

## Who we share it with
Only the services that help us run the shop: our payment provider, delivery companies, and the hosting and database providers that store the website data. We do not sell your information.

## Cookies and storage
We use your browser's storage to keep your bag and keep you signed in.

## Your rights
You can ask to see, correct or delete your information at any time by emailing mgmt@leensummaqa.com.

## Changes
We may update this page from time to time.$b$)),
 ('page_terms', jsonb_build_object('title','Terms','review_note','DRAFT. The old Terms page was a blank Turkish distance-sales template (Turkish law, empty buyer and seller fields), so it was NOT copied. Have these terms reviewed, and add your legal business name and address, before launch.','body',$b$These terms apply to orders placed on this website.

## Orders and prices
All prices are in Jordanian dinars (JOD) unless shown otherwise. The total, including shipping, is shown at checkout before you pay. We may cancel an order if a piece is no longer available, and we will refund any payment made.

## Pre-orders
Some pieces are made to order. Pre-order: 2 weeks production + shipping time applies.

## Payment
Payment is taken at checkout by our payment provider. An order is confirmed once payment is received.

## Shipping
We ship worldwide. See our [Shipping](/shipping) page.

## Returns
See our [Returns](/returns) page.

## Contact
Leen Summaqa, mgmt@leensummaqa.com.$b$))
on conflict (section) do update set data = excluded.data;
