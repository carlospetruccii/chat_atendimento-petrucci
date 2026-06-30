-- 1) Bootstrap idempotente do registro bot_ativado_em.
INSERT INTO public.system_config (chave, valor, tipo, descricao)
VALUES (
  'bot_ativado_em',
  to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'data',
  'Timestamp ISO da última transição off→on do bot. Usado pelo triagem-bot para ignorar inbounds anteriores à religação.'
)
ON CONFLICT (chave) DO NOTHING;

-- 2) Atualiza a RPC de reativação para também setar bot_ativado_em.
CREATE OR REPLACE FUNCTION public.cron_reativar_bot()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_valor_anterior_bot text;
  v_agendamento_anterior text;
  v_now_iso text;
BEGIN
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', '00000000-0000-0000-0000-000000000002')::text,
    true
  );

  SELECT valor INTO v_valor_anterior_bot
    FROM public.system_config WHERE chave = 'bot_ativo';

  SELECT valor INTO v_agendamento_anterior
    FROM public.system_config WHERE chave = 'bot_ativacao_programada';

  v_now_iso := to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  UPDATE public.system_config
     SET valor = 'true', updated_at = now()
   WHERE chave = 'bot_ativo';

  UPDATE public.system_config
     SET valor = NULL, updated_at = now()
   WHERE chave = 'bot_ativacao_programada';

  UPDATE public.system_config
     SET valor = v_now_iso, updated_at = now()
   WHERE chave = 'bot_ativado_em';

  RETURN jsonb_build_object(
    'valor_anterior_bot', v_valor_anterior_bot,
    'agendamento_anterior', v_agendamento_anterior,
    'bot_ativado_em', v_now_iso
  );
END;
$function$;