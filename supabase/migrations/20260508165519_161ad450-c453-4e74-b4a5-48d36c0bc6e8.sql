ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS tentativas_envio integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_mensagens_retry_candidatos
  ON public.mensagens (created_at)
  WHERE status_envio = 'falha' AND tentativas_envio < 3;