CREATE OR REPLACE FUNCTION public.repassar_atendimento(
  p_atendimento_id uuid,
  p_to_user_id uuid,
  p_observacao text DEFAULT NULL
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
  v_from_dept uuid;
  v_to_user_dept uuid;
  v_to_dept uuid;
  v_to_ativo boolean;
  v_to_is_system boolean;
  v_is_supervisor boolean;
  v_dept_changed boolean;
  v_updated_count int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT assigned_to, status, current_department_id
    INTO v_assigned_to, v_status, v_from_dept
    FROM public.atendimentos
   WHERE id = p_atendimento_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Atendimento não encontrado' USING ERRCODE = 'P0002';
  END IF;

  IF v_status = 'encerrado' THEN
    RAISE EXCEPTION 'Atendimento já encerrado' USING ERRCODE = 'P0002';
  END IF;

  IF p_to_user_id = v_assigned_to THEN
    RAISE EXCEPTION 'Atendimento já está com este colaborador' USING ERRCODE = '22023';
  END IF;

  SELECT department_id, ativo, is_system_user
    INTO v_to_user_dept, v_to_ativo, v_to_is_system
    FROM public.users
   WHERE id = p_to_user_id;

  IF NOT FOUND OR v_to_ativo = false OR v_to_is_system = true THEN
    RAISE EXCEPTION 'Colaborador destino inválido' USING ERRCODE = '22023';
  END IF;

  -- Resolve destination department: prefer the destination user's department,
  -- otherwise keep the atendimento's current department (required by check constraint).
  v_to_dept := COALESCE(v_to_user_dept, v_from_dept);

  IF v_to_dept IS NULL THEN
    RAISE EXCEPTION 'Colaborador destino sem departamento e atendimento sem departamento' USING ERRCODE = '22023';
  END IF;

  v_is_supervisor := (v_assigned_to IS DISTINCT FROM v_user_id);
  IF v_is_supervisor THEN
    IF NOT (
      public.current_user_is_superadmin()
      OR public.has_permission('force_close')
      OR public.has_permission('assign_pending')
    ) THEN
      RAISE EXCEPTION 'Sem permissão para repassar este atendimento' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_dept_changed := (v_from_dept IS DISTINCT FROM v_to_dept);

  UPDATE public.atendimentos
     SET assigned_to = p_to_user_id,
         status = 'reservado',
         current_department_id = v_to_dept,
         assigned_at = now(),
         transferred_count = transferred_count + 1
   WHERE id = p_atendimento_id
     AND status <> 'encerrado';

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.timeline_events
    (atendimento_id, tipo_evento, actor_user_id, target_user_id,
     from_department_id, to_department_id, payload)
  VALUES
    (p_atendimento_id, 'repassado', v_user_id, p_to_user_id,
     v_from_dept, v_to_dept,
     jsonb_build_object(
       'observacao', NULLIF(btrim(COALESCE(p_observacao, '')), ''),
       'dept_alterado', v_dept_changed,
       'supervisor_action', v_is_supervisor,
       'destino_sem_departamento', v_to_user_dept IS NULL
     ));

  RETURN true;
END;
$$;