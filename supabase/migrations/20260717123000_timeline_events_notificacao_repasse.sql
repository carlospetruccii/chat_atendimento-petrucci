-- Idempotência da notificação de repasse: carimba quando o aviso de WhatsApp
-- já foi disparado para um evento de repasse/atribuição, garantindo no máximo
-- 1 aviso por evento (trava anti-spam via claim atômico na Edge Function
-- notificar-repasse).
ALTER TABLE public.timeline_events
  ADD COLUMN IF NOT EXISTS notificacao_repasse_enviada_at timestamptz;

COMMENT ON COLUMN public.timeline_events.notificacao_repasse_enviada_at IS
  'Quando a notificação de repasse foi disparada ao WhatsApp do colaborador. Garante idempotência: 1 aviso por evento.';
