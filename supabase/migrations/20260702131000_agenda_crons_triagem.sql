-- Agendamento dos crons operacionais (triagem-bot + automações).
--
-- Cadências (conforme documentado em cada função e em docs/mapa-sistema/03):
--   triagem-bot ................. a cada 10 segundos
--   cron-retry-mensagens-falha .. a cada 2 minutos
--   cron-notificacao-admin ...... a cada 5 minutos
--   cron-encerramento-automatico  a cada 30 minutos
--   cron-bot-reactivation ....... 1x/dia (03:00 UTC = 00:00 America/Sao_Paulo)
--
-- Todas respeitam o kill-switch (bot_ativo) dentro do próprio código; com o bot
-- desligado elas rodam e retornam cedo, sem efeito. Recebimento (webhook) e envio
-- manual não dependem destes jobs.
--
-- O gateway das Edge Functions exige header Authorization mesmo com verify_jwt=false,
-- então enviamos a anon key (pública, a mesma do frontend). Idempotente: reagenda
-- limpo (desagenda antes se já existir).

DO $$
DECLARE
  v_base text := 'https://hfcfkxozzbrzzrejtbdj.supabase.co/functions/v1/';
  v_headers text := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhmY2ZreG96emJyenpyZWp0YmRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NDMzMzcsImV4cCI6MjA5ODQxOTMzN30.Ub8wAgywPWbN3Q8Pk9kDntlQj4H0Lyvlej1JWXjyu5I"}';
  v_names text[] := ARRAY[
    'triagem-bot','cron-retry-mensagens-falha','cron-notificacao-admin',
    'cron-encerramento-automatico','cron-bot-reactivation'
  ];
  r record;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
          AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')) THEN
    RAISE NOTICE 'pg_cron/pg_net ausentes — pulando agendamento.';
    RETURN;
  END IF;

  -- Desagenda versões anteriores (se existirem) para reaplicar limpo.
  FOR r IN SELECT jobname FROM cron.job WHERE jobname = ANY(v_names) LOOP
    PERFORM cron.unschedule(r.jobname);
  END LOOP;

  PERFORM cron.schedule('triagem-bot', '10 seconds', format(
    'SELECT net.http_post(url:=%L, headers:=%L::jsonb, body:=%L::jsonb);',
    v_base || 'triagem-bot', v_headers, '{}'));

  PERFORM cron.schedule('cron-retry-mensagens-falha', '*/2 * * * *', format(
    'SELECT net.http_post(url:=%L, headers:=%L::jsonb, body:=%L::jsonb);',
    v_base || 'cron-retry-mensagens-falha', v_headers, '{}'));

  PERFORM cron.schedule('cron-notificacao-admin', '*/5 * * * *', format(
    'SELECT net.http_post(url:=%L, headers:=%L::jsonb, body:=%L::jsonb);',
    v_base || 'cron-notificacao-admin', v_headers, '{}'));

  PERFORM cron.schedule('cron-encerramento-automatico', '*/30 * * * *', format(
    'SELECT net.http_post(url:=%L, headers:=%L::jsonb, body:=%L::jsonb);',
    v_base || 'cron-encerramento-automatico', v_headers, '{}'));

  PERFORM cron.schedule('cron-bot-reactivation', '0 3 * * *', format(
    'SELECT net.http_post(url:=%L, headers:=%L::jsonb, body:=%L::jsonb);',
    v_base || 'cron-bot-reactivation', v_headers, '{}'));
END $$;
