DO $$
DECLARE
  v_user uuid := '2b1fdda2-1464-41db-b80b-b7342e8ae16d';
  v_atendimentos uuid[];
BEGIN
  SELECT array_agg(id) INTO v_atendimentos
  FROM public.atendimentos
  WHERE assigned_to = v_user OR closed_by_user_id = v_user;

  -- Desabilita triggers append-only para limpeza pontual
  ALTER TABLE public.timeline_events DISABLE TRIGGER USER;
  ALTER TABLE public.mensagens DISABLE TRIGGER USER;

  IF v_atendimentos IS NOT NULL THEN
    DELETE FROM public.timeline_events WHERE atendimento_id = ANY(v_atendimentos);
    DELETE FROM public.notificacoes_luana WHERE atendimento_id = ANY(v_atendimentos);
    DELETE FROM public.mensagens WHERE atendimento_id = ANY(v_atendimentos);
    DELETE FROM public.atendimentos WHERE id = ANY(v_atendimentos);
  END IF;

  -- Mensagens enviadas por ele em outros atendimentos: zera autor
  UPDATE public.mensagens SET sent_by_user_id = NULL WHERE sent_by_user_id = v_user;

  ALTER TABLE public.timeline_events ENABLE TRIGGER USER;
  ALTER TABLE public.mensagens ENABLE TRIGGER USER;

  DELETE FROM public.user_permissions WHERE user_id = v_user;
  DELETE FROM public.users WHERE id = v_user;
  DELETE FROM auth.users WHERE id = v_user;
END $$;