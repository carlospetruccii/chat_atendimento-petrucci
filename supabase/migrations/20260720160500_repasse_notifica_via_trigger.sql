-- =====================================================================
-- Notificação de repasse robusta: dispara no SERVIDOR (trigger + pg_net),
-- não mais dependente do navegador chamar a Edge Function.
--
-- Causa raiz do bug: a notificação era um fire-and-forget do frontend
-- (`void notificarRepasse`), com janela de 2min e erros engolidos. Na única
-- vez real testada não resultou em envio (build/cache do navegador ou janela
-- perdida). Aqui o próprio banco chama a função assim que um evento de
-- repasse/atribuição cross-user é gravado — garantido, idempotente.
-- =====================================================================

-- 1) Segredo interno para autenticar a chamada trigger → Edge Function.
-- RLS deny-all: anon/authenticated não leem; service_role (Edge Function) e
-- funções SECURITY DEFINER (o trigger) bypassam RLS.
CREATE TABLE IF NOT EXISTS public.app_secrets (
  key text PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_secrets ENABLE ROW LEVEL SECURITY;
-- Sem POLICY nenhuma → nega tudo para anon/authenticated. service_role bypassa.
REVOKE ALL ON public.app_secrets FROM anon, authenticated;

INSERT INTO public.app_secrets (key, value)
VALUES ('repasse_internal', encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;

-- 1b) Ledger de idempotência do aviso de repasse. NÃO usamos uma coluna em
-- timeline_events porque essa tabela é append-only (trigger block_timeline_
-- update_delete bloqueia qualquer UPDATE) — um UPDATE de claim lá SEMPRE falha.
-- Aqui o claim é um INSERT com ON CONFLICT DO NOTHING (mesmo padrão do ledger
-- alertas_atendimento_parado): quem insere primeiro envia; os demais caem fora.
CREATE TABLE IF NOT EXISTS public.repasse_notificacoes (
  timeline_event_id uuid PRIMARY KEY REFERENCES public.timeline_events(id) ON DELETE CASCADE,
  enviada_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.repasse_notificacoes ENABLE ROW LEVEL SECURITY;
-- Sem POLICY → nega anon/authenticated; service_role (Edge Function) bypassa.
REVOKE ALL ON public.repasse_notificacoes FROM anon, authenticated;

-- 2) Trigger: em cada evento de repasse/atribuição cross-user, chama a função.
CREATE OR REPLACE FUNCTION public.notify_repasse_via_pgnet()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base    text := 'https://hfcfkxozzbrzzrejtbdj.supabase.co/functions/v1/notificar-repasse';
  v_anon    text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhmY2ZreG96emJyenpyZWp0YmRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NDMzMzcsImV4cCI6MjA5ODQxOTMzN30.Ub8wAgywPWbN3Q8Pk9kDntlQj4H0Lyvlej1JWXjyu5I';
  v_secret  text;
BEGIN
  -- Só repasse/atribuição REAL para OUTRA pessoa (auto-atribuição não notifica).
  IF NEW.tipo_evento IN ('repassado', 'reservado')
     AND NEW.target_user_id IS NOT NULL
     AND NEW.actor_user_id IS NOT NULL
     AND NEW.actor_user_id IS DISTINCT FROM NEW.target_user_id THEN

    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
      RETURN NEW; -- ambiente sem pg_net: no-op silencioso
    END IF;

    SELECT value INTO v_secret FROM public.app_secrets WHERE key = 'repasse_internal';

    PERFORM net.http_post(
      url := v_base,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_anon,
        'x-internal-secret', COALESCE(v_secret, '')
      ),
      body := jsonb_build_object('timeline_event_id', NEW.id)
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.notify_repasse_via_pgnet() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_timeline_notify_repasse ON public.timeline_events;
CREATE TRIGGER trg_timeline_notify_repasse
  AFTER INSERT ON public.timeline_events
  FOR EACH ROW EXECUTE FUNCTION public.notify_repasse_via_pgnet();
