create policy "mensagens_midia_select_visivel"
on storage.objects for select
to authenticated
using (
  bucket_id = 'mensagens-midia'
  and exists (
    select 1 from public.mensagens m
    where m.media_metadata->>'storage_path' = storage.objects.name
  )
);