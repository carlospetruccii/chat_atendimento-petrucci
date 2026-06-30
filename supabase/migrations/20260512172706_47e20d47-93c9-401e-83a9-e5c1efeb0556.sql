CREATE OR REPLACE FUNCTION public.encerrar_atendimento(
  p_atendimento_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_assigned_to uuid;
  v_status status_atendimento;
  v_is_supervisor boolean;
  v_close_reason close_reason;
  v_updated_count int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT assigned_to, status
    INTO v_assigned_to, v_status
    FROM public.atendimentos
   WHERE id = p_atendimento_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Atendimento não encontrado' USING ERRCODE = 'P0002';
  END IF;

  IF v_status = 'encerrado' THEN
    RETURN false;
  END IF;

  v_is_supervisor := (v_assigned_to IS DISTINCT FROM v_user_id);

  IF v_is_supervisor THEN
    IF NOT (public.current_user_is_superadmin() OR public.has_permission('force_close')) THEN
      RAISE EXCEPTION 'Sem permissão para encerrar este atendimento' USING ERRCODE = '42501';
    END IF;
    v_close_reason := 'manual_supervisor';
  ELSE
    v_close_reason := 'manual_atendente';
  END IF;

  UPDATE public.atendimentos
     SET status = 'encerrado',
         closed_at = now(),
         closed_by_user_id = v_user_id,
         close_reason = v_close_reason
   WHERE id = p_atendimento_id
     AND status <> 'encerrado';

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.timeline_events
    (atendimento_id, tipo_evento, actor_user_id, payload)
  VALUES
    (p_atendimento_id, 'encerrado', v_user_id,
     jsonb_build_object(
       'motivo', NULLIF(btrim(COALESCE(p_motivo, '')), ''),
       'close_reason', v_close_reason::text,
       'supervisor_action', v_is_supervisor
     ));

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.encerrar_atendimento(uuid, text) TO authenticated;