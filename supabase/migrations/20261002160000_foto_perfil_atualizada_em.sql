-- Foto de perfil de clientes e grupos (WhatsApp/uazapi).
--
-- O link da foto vem do CDN do WhatsApp e EXPIRA, então guardamos quando ela
-- foi conferida (foto_atualizada_em) e o backend renova depois de alguns dias
-- (ver supabase/functions/_shared/foto-perfil-sync.ts).
--
-- clients.foto_url / foto_atualizada_em já existem no banco remoto sem
-- migration no repositório: o IF NOT EXISTS só registra o schema aqui.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS foto_url text,
  ADD COLUMN IF NOT EXISTS foto_atualizada_em timestamptz;

ALTER TABLE public.grupos
  ADD COLUMN IF NOT EXISTS foto_atualizada_em timestamptz;
