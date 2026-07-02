-- Rename "Luana" -> "Administrador" (sem vestígio no estado atual do banco).
-- Tabela vazia (0 notificações); rename preserva tudo. Não acorda multi-empresa.
-- Objetos históricos em migrations antigas permanecem como registro (não reescritos).

BEGIN;

-- Tabela + índices + constraints
ALTER TABLE public.notificacoes_luana RENAME TO notificacoes_admin;
ALTER INDEX IF EXISTS public.idx_notif_luana_atendimento RENAME TO idx_notif_admin_atendimento;
ALTER INDEX IF EXISTS public.idx_notif_luana_nao_lidas   RENAME TO idx_notif_admin_nao_lidas;
ALTER INDEX IF EXISTS public.idx_notificacoes_luana_company RENAME TO idx_notificacoes_admin_company;
ALTER TABLE public.notificacoes_admin RENAME CONSTRAINT notificacoes_luana_pkey                TO notificacoes_admin_pkey;
ALTER TABLE public.notificacoes_admin RENAME CONSTRAINT notificacoes_luana_atendimento_id_fkey TO notificacoes_admin_atendimento_id_fkey;
ALTER TABLE public.notificacoes_admin RENAME CONSTRAINT notificacoes_luana_company_fk          TO notificacoes_admin_company_fk;

-- Policies (as atuais checam por empresa; só renomeamos)
ALTER POLICY notif_luana_select ON public.notificacoes_admin RENAME TO notif_admin_select;
ALTER POLICY notif_luana_update ON public.notificacoes_admin RENAME TO notif_admin_update;

-- Função renomeada (corpo idêntico ao atual, já sem 'assunto')
CREATE OR REPLACE FUNCTION public.payload_notificacao_admin(p_atendimento_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_minutos integer; v_horas integer; v_resto integer; v_tempo text; v_payload jsonb;
BEGIN
  SELECT COALESCE(EXTRACT(EPOCH FROM (now() - COALESCE(a.last_message_at, a.created_at))) / 60, 0)::int
  INTO v_minutos FROM public.atendimentos a WHERE a.id = p_atendimento_id;
  IF v_minutos IS NULL THEN RETURN NULL; END IF;
  v_horas := v_minutos / 60; v_resto := v_minutos % 60;
  IF v_horas > 0 THEN v_tempo := v_horas || 'h ' || v_resto || 'min'; ELSE v_tempo := v_resto || 'min'; END IF;
  SELECT jsonb_build_object(
    'nome_cliente', COALESCE(c.nome, c.numero_whatsapp),
    'telefone', c.numero_whatsapp,
    'departamento', COALESCE(d.nome, '—'),
    'tempo_aguardando', v_tempo
  ) INTO v_payload
  FROM public.atendimentos a
  JOIN public.clients c ON c.id = a.client_id
  LEFT JOIN public.departments d ON d.id = a.current_department_id
  WHERE a.id = p_atendimento_id;
  RETURN v_payload;
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.payload_notificacao_admin(uuid) FROM PUBLIC, anon;
DROP FUNCTION IF EXISTS public.payload_notificacao_luana(uuid);

-- Chaves de config, template e permissão (idempotente; 0 linhas hoje)
UPDATE public.system_config     SET chave = replace(chave, '_luana', '_admin') WHERE chave LIKE '%_luana%';
UPDATE public.templates_mensagem SET chave = 'notificacao_admin'             WHERE chave = 'notificacao_luana';
UPDATE public.user_permissions   SET permission = 'view_admin_notifications' WHERE permission = 'view_luana_notifications';

-- Cron: reaponta para a nova Edge Function cron-notificacao-admin
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') AND EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_net') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='cron-notificacao-luana') THEN PERFORM cron.unschedule('cron-notificacao-luana'); END IF;
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='cron-notificacao-admin') THEN PERFORM cron.unschedule('cron-notificacao-admin'); END IF;
    PERFORM cron.schedule('cron-notificacao-admin', '*/5 * * * *',
      'SELECT net.http_post(url:=' || quote_literal('https://hfcfkxozzbrzzrejtbdj.supabase.co/functions/v1/cron-notificacao-admin')
      || ', headers:=' || quote_literal('{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhmY2ZreG96emJyenpyZWp0YmRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NDMzMzcsImV4cCI6MjA5ODQxOTMzN30.Ub8wAgywPWbN3Q8Pk9kDntlQj4H0Lyvlej1JWXjyu5I"}') || '::jsonb, body:=' || quote_literal('{}') || '::jsonb);');
  END IF;
END $do$;

COMMIT;
