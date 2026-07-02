-- Sincronização CONTÍNUA da agenda do Google.
--
-- Agenda um job pg_cron que, a cada 15 minutos, chama a Edge Function
-- google-contacts com { action: "sync" }. A função:
--   - é NO-OP quando não há conta Google conectada (retorna ok:false sem erro);
--   - faz sincronização INCREMENTAL (só o que mudou) via syncToken da People API.
--
-- Assim, contato novo/editado no Google aparece sozinho no sistema, sem
-- reimportar. O botão "Atualizar agora" (Configurações › Agenda Google e tela
-- Agenda) continua disponível para forçar na hora.
--
-- O gateway das Edge Functions exige header Authorization mesmo com
-- verify_jwt=false, então enviamos a anon key (pública, a mesma do frontend) —
-- mesmo padrão dos demais crons. Defensivo (só agenda se pg_cron/pg_net
-- existirem) e idempotente (reagenda limpo).

DO $$
DECLARE
  v_url text := 'https://hfcfkxozzbrzzrejtbdj.supabase.co/functions/v1/google-contacts';
  v_headers text := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhmY2ZreG96emJyenpyZWp0YmRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NDMzMzcsImV4cCI6MjA5ODQxOTMzN30.Ub8wAgywPWbN3Q8Pk9kDntlQj4H0Lyvlej1JWXjyu5I"}';
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
          AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')) THEN
    RAISE NOTICE 'pg_cron/pg_net ausentes — pulando agendamento da agenda Google.';
    RETURN;
  END IF;

  -- Remove agendamento anterior (se existir) para reaplicar limpo.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'google-agenda-sync') THEN
    PERFORM cron.unschedule('google-agenda-sync');
  END IF;

  PERFORM cron.schedule('google-agenda-sync', '*/15 * * * *', format(
    'SELECT net.http_post(url:=%L, headers:=%L::jsonb, body:=%L::jsonb);',
    v_url, v_headers, '{"action":"sync"}'));
END $$;
