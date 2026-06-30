-- Função usada pela Edge Function cron-bot-reactivation.
-- Faz os UPDATEs em system_config dentro da mesma transação em que define
-- request.jwt.claims.sub = UUID do usuário Sistema, para que o trigger
-- log_config_change registre esse UUID em config_audit_log.user_id.
CREATE OR REPLACE FUNCTION public.cron_reativar_bot()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_valor_anterior_bot text;
  v_agendamento_anterior text;
BEGIN
  -- Identifica o autor das mudanças como o usuário Sistema na transação atual.
  -- auth.uid() lê de request.jwt.claims->>'sub'.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', '00000000-0000-0000-0000-000000000002')::text,
    true
  );

  SELECT valor INTO v_valor_anterior_bot
    FROM public.system_config WHERE chave = 'bot_ativo';

  SELECT valor INTO v_agendamento_anterior
    FROM public.system_config WHERE chave = 'bot_ativacao_programada';

  UPDATE public.system_config
     SET valor = 'true', updated_at = now()
   WHERE chave = 'bot_ativo';

  UPDATE public.system_config
     SET valor = NULL, updated_at = now()
   WHERE chave = 'bot_ativacao_programada';

  RETURN jsonb_build_object(
    'valor_anterior_bot', v_valor_anterior_bot,
    'agendamento_anterior', v_agendamento_anterior
  );
END;
$$;

-- Apenas service_role precisa executar (chamada da Edge Function).
REVOKE ALL ON FUNCTION public.cron_reativar_bot() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cron_reativar_bot() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_reativar_bot() TO service_role;