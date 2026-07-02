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
-- Defensivo: só agenda se pg_cron e pg_net existirem; idempotente (reaplica
-- o agendamento). NÃO mexe em nenhum dado existente.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN

    -- Remove agendamento anterior (se já existir) para reaplicar limpo.
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'google-agenda-sync') THEN
      PERFORM cron.unschedule('google-agenda-sync');
    END IF;

    PERFORM cron.schedule(
      'google-agenda-sync',
      '*/15 * * * *',
      $cron$
        SELECT net.http_post(
          url := 'https://hfcfkxozzbrzzrejtbdj.supabase.co/functions/v1/google-contacts',
          headers := '{"Content-Type": "application/json"}'::jsonb,
          body := '{"action": "sync"}'::jsonb
        );
      $cron$
    );
  END IF;
END $$;
