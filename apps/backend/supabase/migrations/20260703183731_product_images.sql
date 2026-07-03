-- Product images: multiple photos per product.
-- Paths (not URLs) are stored in products.image_urls; files live in the public
-- `product-images` Storage bucket under {merchant_id}/{product_id}/…

alter table public.products
  add column if not exists image_urls text[] not null default '{}';

-- Public bucket: images are world-readable by URL (storefront is public).
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- storage.objects already has RLS enabled by Supabase.

-- Anyone may read objects in this bucket (public storefront).
drop policy if exists product_images_read_public on storage.objects;
create policy product_images_read_public on storage.objects
  for select using (bucket_id = 'product-images');

-- A merchant may write only inside their own folder (first path segment = their
-- merchant id). Mirrors products_write_own scoping via current_merchant_id().
drop policy if exists product_images_write_own on storage.objects;
create policy product_images_write_own on storage.objects
  for all
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = public.current_merchant_id()::text
  )
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = public.current_merchant_id()::text
  );
