-- Índice para a varredura de envios incertos do cron-retry-mensagens-falha.
--
-- Quando a uazapi não responde, a mensagem fica em 'enviando' com o carimbo
-- media_metadata->>'envio_incerto_em' (ver supabase/functions/_shared/erro-envio.ts).
-- O cron varre essas linhas a cada execução, nas duas tabelas de mensagem.
-- Sem estes índices a varredura é Seq Scan — barato hoje, caro quando a tabela
-- crescer. Espelha o idx_mensagens_retry_candidatos, que já cobre o 'falha'.

CREATE INDEX IF NOT EXISTS idx_mensagens_envio_incerto
  ON public.mensagens ((media_metadata->>'envio_incerto_em'))
  WHERE status_envio = 'enviando' AND zapi_message_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_grupo_mensagens_envio_incerto
  ON public.grupo_mensagens ((media_metadata->>'envio_incerto_em'))
  WHERE status_envio = 'enviando' AND uazapi_message_id IS NULL;
