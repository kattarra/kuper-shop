-- Public product images. Uploads are performed by the authenticated admin API using the service role key.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  2097152,
  array['image/jpeg','image/png','image/webp']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can view KuperShop product images" on storage.objects;
create policy "Public can view KuperShop product images"
on storage.objects for select
to public
using (bucket_id = 'product-images');
