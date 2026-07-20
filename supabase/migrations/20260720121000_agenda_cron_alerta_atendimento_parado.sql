-- Agenda o cron-alerta-atendimento-parado a cada 5 minutos (pg_cron + pg_net),
-- mesmo padrão/anon key dos demais crons. Idempotente: desagenda antes.
-- A função respeita kill-switch e horário comercial no próprio código.
DO $$
DECLARE
  v_base text := 'https://hfcfkxozzbrzzrejtbdj.supabase.co/functions/v1/';
  v_headers text := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhmY2ZreG96emJyenpyZWp0YmRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NDMzMzcsImV4cCI6MjA5ODQxOTMzN30.Ub8wAgywPWbN3Q8Pk9kDntlQj4H0Lyvlej1JWXjyu5I"}';
  v_job text := 'cron-alerta-atendimento-parado';
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
          AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')) THEN
    RAISE NOTICE 'pg_cron/pg_net ausentes — pulando agendamento.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job) THEN
    PERFORM cron.unschedule(v_job);
  END IF;

  PERFORM cron.schedule(v_job, '*/5 * * * *', format(
    'SELECT net.http_post(url:=%L, headers:=%L::jsonb, body:=%L::jsonb);',
    v_base || v_job, v_headers, '{}'));
END $$;
