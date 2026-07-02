-- Renomeia a tabela agenda_contatos → contatos e o job de cron
-- google-agenda-sync → google-contatos-sync.
--
-- Motivo: a tela "Agenda" foi renomeada para "Contatos" (é uma lista de
-- contatos do Google) e substituiu a antiga tela "Clientes". O rename PRESERVA
-- os dados (é só troca de nome). Objetos dependentes (constraint, índices,
-- policy, trigger) também são renomeados para manter a nomenclatura consistente.
--
-- Idempotente: todos os passos usam guardas IF EXISTS, então re-rodar é seguro.

ALTER TABLE IF EXISTS public.agenda_contatos RENAME TO contatos;

DO $$
BEGIN
  -- Constraint do número E.164.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agenda_numero_e164') THEN
    ALTER TABLE public.contatos RENAME CONSTRAINT agenda_numero_e164 TO contatos_numero_e164;
  END IF;

  -- Policy de leitura.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'contatos' AND policyname = 'agenda_contatos_select'
  ) THEN
    ALTER POLICY agenda_contatos_select ON public.contatos RENAME TO contatos_select;
  END IF;

  -- Trigger de updated_at.
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_agenda_contatos_updated_at'
      AND tgrelid = 'public.contatos'::regclass
  ) THEN
    ALTER TRIGGER trg_agenda_contatos_updated_at ON public.contatos
      RENAME TO trg_contatos_updated_at;
  END IF;
END $$;

-- Índices.
ALTER INDEX IF EXISTS uniq_agenda_company_resource RENAME TO uniq_contatos_company_resource;
ALTER INDEX IF EXISTS idx_agenda_company_numero RENAME TO idx_contatos_company_numero;
ALTER INDEX IF EXISTS idx_agenda_nome RENAME TO idx_contatos_nome;

-- Re-aponta o cron: desagenda 'google-agenda-sync' e agenda 'google-contatos-sync'
-- (mesma cadência e mesmo endpoint; só o nome do job muda). Header Authorization
-- com anon key, igual aos demais crons.
DO $$
DECLARE
  v_url text := 'https://hfcfkxozzbrzzrejtbdj.supabase.co/functions/v1/google-contacts';
  v_headers text := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhmY2ZreG96emJyenpyZWp0YmRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NDMzMzcsImV4cCI6MjA5ODQxOTMzN30.Ub8wAgywPWbN3Q8Pk9kDntlQj4H0Lyvlej1JWXjyu5I"}';
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
          AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')) THEN
    RAISE NOTICE 'pg_cron/pg_net ausentes — pulando reagendamento do cron.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'google-agenda-sync') THEN
    PERFORM cron.unschedule('google-agenda-sync');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'google-contatos-sync') THEN
    PERFORM cron.unschedule('google-contatos-sync');
  END IF;

  PERFORM cron.schedule('google-contatos-sync', '*/15 * * * *', format(
    'SELECT net.http_post(url:=%L, headers:=%L::jsonb, body:=%L::jsonb);',
    v_url, v_headers, '{"action":"sync"}'));
END $$;
