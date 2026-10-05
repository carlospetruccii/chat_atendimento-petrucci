-- "Atribuir a mim" e "Repassar" passam a funcionar com o atendimento AINDA em
-- triagem.
--
-- Até aqui as duas RPCs recusavam status = 'em_triagem' com P0002 e o frontend
-- mostrava "Atendimento ainda está em triagem — aguarde o bot terminar". Na
-- prática isso só atrapalha: quem já sabe quem tem que atender fica esperando o
-- bot terminar um menu que o cliente talvez nunca responda.
--
-- Decisão de produto (02/09/2026): a pessoa manda no bot. Assumir/repassar
-- durante a triagem encerra a triagem daquele atendimento (estágio 'concluida'
-- + triagem_finished_at) e leva a conversa direto para o responsável.
--
-- Contrapartida no bot (supabase/functions/triagem-bot): toda escrita dele em
-- atendimentos passou a filtrar status = 'em_triagem', para uma rodada que já
-- estava em andamento não sobrescrever o que o humano acabou de fazer. Nas
-- rodadas seguintes o atendimento nem aparece — a query do bot já filtra por
-- 'em_triagem'.
--
-- Departamento: segue a mesma regra de sempre (o do responsável, senão o do
-- atendimento). Vindo da triagem ele costuma ser NULL, e a CHECK aceita porque
-- assigned_to fica preenchido.

CREATE OR REPLACE FUNCTION public.assumir_atendimento(p_atendimento_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_company uuid;
  v_client_id uuid;
  v_assigned_to uuid;
  v_status status_atendimento;
  v_from_dept uuid;
  v_my_dept uuid;
  v_my_role text;
  v_to_dept uuid;
  v_outro_ativo uuid;
  v_era_encerrado boolean;
  v_era_triagem boolean;
  v_is_takeover boolean;
  v_dept_changed boolean;
  v_updated_count int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT company_id, client_id, assigned_to, status, current_department_id
    INTO v_company, v_client_id, v_assigned_to, v_status, v_from_dept
    FROM public.atendimentos
   WHERE id = p_atendimento_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Atendimento não encontrado' USING ERRCODE = 'P0002';
  END IF;

  -- Departamento vem de company_members (é o que current_department_in usa nas
  -- policies), não de users.department_id.
  SELECT m.role, m.department_id
    INTO v_my_role, v_my_dept
    FROM public.company_members m
   WHERE m.company_id = v_company AND m.user_id = v_user_id AND m.ativo = true;

  IF v_my_role IS NULL THEN
    RAISE EXCEPTION 'Sem acesso a este atendimento' USING ERRCODE = '42501';
  END IF;

  -- Já é meu e está aberto: nada a fazer.
  IF v_assigned_to = v_user_id AND v_status <> 'encerrado' THEN
    RETURN false;
  END IF;

  v_era_encerrado := (v_status = 'encerrado');
  v_era_triagem := (v_status = 'em_triagem');

  -- Um cliente só pode ter um atendimento ativo (uniq_atendimento_ativo_por_cliente).
  IF v_era_encerrado THEN
    SELECT id INTO v_outro_ativo
      FROM public.atendimentos
     WHERE client_id = v_client_id
       AND id <> p_atendimento_id
       AND status <> 'encerrado'
     LIMIT 1;

    IF v_outro_ativo IS NOT NULL THEN
      RAISE EXCEPTION 'Cliente já tem uma conversa ativa' USING ERRCODE = '23505';
    END IF;
  END IF;

  v_is_takeover := (v_assigned_to IS NOT NULL AND v_assigned_to IS DISTINCT FROM v_user_id);
  IF v_is_takeover THEN
    IF NOT (
      public.current_user_is_superadmin()
      OR public.has_permission('force_close')
      OR public.has_permission('assign_pending')
    ) THEN
      RAISE EXCEPTION 'Sem permissão para assumir este atendimento' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- O departamento segue a pessoa responsável (mesma regra de claim_pendente e
  -- repassar_atendimento). Pode terminar NULL para quem não tem departamento —
  -- a CHECK aceita, porque assigned_to fica preenchido.
  v_to_dept := COALESCE(v_my_dept, v_from_dept);
  v_dept_changed := (v_from_dept IS DISTINCT FROM v_to_dept);

  UPDATE public.atendimentos
     SET assigned_to = v_user_id,
         status = 'em_atendimento',
         assigned_at = now(),
         current_department_id = v_to_dept,
         closed_at = NULL,
         closed_by_user_id = NULL,
         close_reason = NULL,
         -- Assumir durante a triagem encerra a triagem: o bot não tem mais o
         -- que perguntar, e quem lê estágio/tempo de triagem depois veria um
         -- atendimento humano preso em 'aguardando_departamento'.
         triagem_estagio = CASE WHEN v_era_triagem
                                THEN 'concluida'::triagem_estagio
                                ELSE triagem_estagio END,
         triagem_finished_at = CASE WHEN v_era_triagem
                                    THEN COALESCE(triagem_finished_at, now())
                                    ELSE triagem_finished_at END
   WHERE id = p_atendimento_id;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count = 0 THEN
    RETURN false;
  END IF;

  -- Carimba mensagens órfãs (não toca em mensagens já carimbadas).
  IF v_to_dept IS NOT NULL THEN
    UPDATE public.mensagens
       SET department_id = v_to_dept
     WHERE atendimento_id = p_atendimento_id
       AND department_id IS NULL;
  END IF;

  INSERT INTO public.timeline_events
    (atendimento_id, tipo_evento, actor_user_id, target_user_id,
     from_department_id, to_department_id, payload)
  VALUES
    (p_atendimento_id, 'atribuido', v_user_id, v_user_id,
     v_from_dept, v_to_dept,
     jsonb_build_object(
       'origem', 'assumir_atendimento',
       'dept_alterado', v_dept_changed,
       'reaberto', v_era_encerrado,
       'durante_triagem', v_era_triagem,
       'supervisor_action', v_is_takeover
     ));

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.repassar_atendimento(p_atendimento_id uuid, p_to_user_id uuid, p_observacao text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_client_id uuid;
  v_assigned_to uuid;
  v_status status_atendimento;
  v_from_dept uuid;
  v_to_user_dept uuid;
  v_to_dept uuid;
  v_to_ativo boolean;
  v_to_is_system boolean;
  v_outro_ativo uuid;
  v_era_encerrado boolean;
  v_era_triagem boolean;
  v_is_supervisor boolean;
  v_dept_changed boolean;
  v_updated_count int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT client_id, assigned_to, status, current_department_id
    INTO v_client_id, v_assigned_to, v_status, v_from_dept
    FROM public.atendimentos
   WHERE id = p_atendimento_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Atendimento não encontrado' USING ERRCODE = 'P0002';
  END IF;

  v_era_encerrado := (v_status = 'encerrado');
  v_era_triagem := (v_status = 'em_triagem');

  IF p_to_user_id = v_assigned_to AND NOT v_era_encerrado THEN
    RAISE EXCEPTION 'Atendimento já está com este colaborador' USING ERRCODE = '22023';
  END IF;

  -- Um cliente só pode ter um atendimento ativo (uniq_atendimento_ativo_por_cliente).
  IF v_era_encerrado THEN
    SELECT id INTO v_outro_ativo
      FROM public.atendimentos
     WHERE client_id = v_client_id
       AND id <> p_atendimento_id
       AND status <> 'encerrado'
     LIMIT 1;

    IF v_outro_ativo IS NOT NULL THEN
      RAISE EXCEPTION 'Cliente já tem uma conversa ativa' USING ERRCODE = '23505';
    END IF;
  END IF;

  SELECT department_id, ativo, is_system_user
    INTO v_to_user_dept, v_to_ativo, v_to_is_system
    FROM public.users
   WHERE id = p_to_user_id;

  IF NOT FOUND OR v_to_ativo = false OR v_to_is_system = true THEN
    RAISE EXCEPTION 'Colaborador destino inválido' USING ERRCODE = '22023';
  END IF;

  -- O departamento segue a pessoa: prefere o do destino, senão mantém o do
  -- atendimento. Pode terminar NULL (destino sem departamento e atendimento
  -- vindo da triagem) — a CHECK aceita, porque assigned_to fica preenchido.
  v_to_dept := COALESCE(v_to_user_dept, v_from_dept);

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
         closed_at = NULL,
         closed_by_user_id = NULL,
         close_reason = NULL,
         transferred_count = transferred_count + 1,
         -- Ver comentário equivalente em assumir_atendimento.
         triagem_estagio = CASE WHEN v_era_triagem
                                THEN 'concluida'::triagem_estagio
                                ELSE triagem_estagio END,
         triagem_finished_at = CASE WHEN v_era_triagem
                                    THEN COALESCE(triagem_finished_at, now())
                                    ELSE triagem_finished_at END
   WHERE id = p_atendimento_id;

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
       'reaberto', v_era_encerrado,
       'durante_triagem', v_era_triagem,
       'supervisor_action', v_is_supervisor,
       'destino_sem_departamento', v_to_user_dept IS NULL
     ));

  RETURN true;
END;
$function$;
