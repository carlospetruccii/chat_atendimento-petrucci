
CREATE OR REPLACE FUNCTION public.assign_pendente_a_usuario(
  p_atendimento_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_to_dept uuid;
  v_to_ativo boolean;
  v_to_is_system boolean;
  v_old_dept uuid;
  v_dept_changed boolean;
  v_updated_count int;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  IF NOT (public.current_user_is_superadmin()
          OR public.has_permission('manage_users')
          OR public.has_permission('assign_pending')) THEN
    RAISE EXCEPTION 'Sem permissão para atribuir atendimentos' USING ERRCODE = '42501';
  END IF;

  SELECT department_id, ativo, is_system_user
    INTO v_to_dept, v_to_ativo, v_to_is_system
    FROM public.users
   WHERE id = p_user_id;

  IF NOT FOUND OR v_to_ativo = false OR v_to_is_system = true THEN
    RAISE EXCEPTION 'Colaborador destino inválido' USING ERRCODE = '22023';
  END IF;

  IF v_to_dept IS NULL THEN
    RAISE EXCEPTION 'Colaborador destino sem departamento' USING ERRCODE = '22023';
  END IF;

  SELECT current_department_id INTO v_old_dept
    FROM public.atendimentos
   WHERE id = p_atendimento_id;

  v_dept_changed := (v_old_dept IS DISTINCT FROM v_to_dept);

  UPDATE public.atendimentos
     SET assigned_to = p_user_id,
         status = 'reservado',
         assigned_at = now(),
         current_department_id = v_to_dept,
         transferred_count = transferred_count + CASE WHEN v_dept_changed THEN 1 ELSE 0 END
   WHERE id = p_atendimento_id
     AND assigned_to IS NULL
     AND status <> 'encerrado';

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count = 0 THEN
    RETURN false;
  END IF;

  UPDATE public.mensagens
     SET department_id = v_to_dept
   WHERE atendimento_id = p_atendimento_id
     AND department_id IS NULL;

  INSERT INTO public.timeline_events
    (atendimento_id, tipo_evento, actor_user_id, target_user_id,
     from_department_id, to_department_id, payload)
  VALUES
    (p_atendimento_id, 'reservado', v_actor, p_user_id,
     v_old_dept, v_to_dept,
     jsonb_build_object('origem', 'assign_pendente_a_usuario', 'dept_alterado', v_dept_changed));

  RETURN true;
END;
$$;
