-- Bucket `mensagens-midia`: torna o SELECT acessível ao papel `public` (que inclui
-- `anon`), coerente com o modo aberto atual — o frontend sem login usa a chave
-- anônima. Antes a policy era só para `authenticated`, então a tela não conseguia
-- gerar a URL assinada da mídia (bucket privado) e mostrava "Mídia indisponível",
-- mesmo com o arquivo baixado e salvo no bucket.
--
-- A restrição de conteúdo continua: só objetos referenciados por alguma linha de
-- `mensagens` (via media_metadata->>'storage_path'). Idempotente.
--
-- OBS multi-empresa: quando `auth_enforcement_enabled` for ligado, esta policy deve
-- ser reavaliada junto com as demais (hoje o modo é aberto/`public`).

drop policy if exists "mensagens_midia_select_visivel" on storage.objects;

create policy "mensagens_midia_select_visivel"
  on storage.objects
  for select
  to public
  using (
    bucket_id = 'mensagens-midia'
    and exists (
      select 1 from public.mensagens m
      where (m.media_metadata ->> 'storage_path') = objects.name
    )
  );
