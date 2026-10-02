-- Cron que renova fotos de perfil vencidas (função atualizar-fotos).
--
-- Clona o comando do job cron-encerramento-automatico trocando só a URL: herda
-- URL do projeto e headers (chave pública) sem repetir a chave aqui. Idempotente:
-- cron.schedule com o mesmo nome substitui o job.

DO $$
DECLARE
  v_cmd text;
BEGIN
  SELECT replace(command, '/functions/v1/cron-encerramento-automatico', '/functions/v1/atualizar-fotos')
    INTO v_cmd
    FROM cron.job
   WHERE jobname = 'cron-encerramento-automatico';

  IF v_cmd IS NULL THEN
    RAISE NOTICE 'cron-encerramento-automatico não existe; atualizar-fotos não agendado';
    RETURN;
  END IF;

  PERFORM cron.schedule('atualizar-fotos', '*/30 * * * *', v_cmd);
END $$;
