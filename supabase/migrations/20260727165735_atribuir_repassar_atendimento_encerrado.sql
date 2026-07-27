-- Corrige "Atribuir a mim" e "Repassar" em atendimento ENCERRADO sem departamento.
--
-- Bug: um atendimento encerrado ainda na triagem fica com
-- current_department_id = NULL (permitido desde
-- 20260702174500_fix_encerrar_triagem_sem_departamento). Depois disso:
--
--   1. "Atribuir a mim" fazia um UPDATE cru no frontend trocando o status para
--      'em_atendimento' sem preencher o departamento -> a CHECK
--      atendimentos_dept_required_after_triagem_chk estourava 23514 e o
--      usuário só via "Não foi possível atribuir o atendimento".
--   2. "Repassar" era bloqueado de propósito por repassar_atendimento
--      ('Atendimento já encerrado', P0002).
--
-- Hoje existem 26 atendimentos encerrados sem departamento, todos travados
-- nesses dois caminhos. reabrirAtendimentoEncerrado (webhook) sofria do mesmo
-- 23514 e falhava calado.
--
-- Correção, em três partes:
--   a) 'encerrado' não é o único estado sem roteamento por departamento: um
--      atendimento com responsável definido já está roteado pela pessoa. A CHECK
--      passa a aceitar assigned_to IS NOT NULL (adicionar um OR nunca invalida
--      linhas existentes).
--   b) A policy de SELECT passa a incluir assigned_to = auth.uid(): quem é o
--      responsável sempre vê seu atendimento, mesmo sem departamento. A policy
--      de UPDATE já tinha essa cláusula — SELECT ficou de fora por descuido, e
--      sem ela (a) criaria conversa invisível para o próprio responsável.
--   c) Atribuir/repassar em atendimento encerrado REABRE o atendimento
--      (decisão de produto: um clique só, é o que o usuário está tentando
--      fazer) e resolve o departamento seguindo a pessoa responsável — mesma
--      regra que claim_pendente e repassar_atendimento já usavam.

-- a) CHECK: responsável definido dispensa departamento.
ALTER TABLE public.atendimentos
  DROP CONSTRAINT IF EXISTS atendimentos_dept_required_after_triagem_chk;

ALTER TABLE public.atendimentos
  ADD CONSTRAINT atendimentos_dept_required_after_triagem_chk
  CHECK (
    status = 'em_triagem'
    OR status = 'encerrado'
    OR current_department_id IS NOT NULL
    OR assigned_to IS NOT NULL
    OR close_reason = 'migracao_inicial'
  );

-- b) SELECT: o responsável sempre vê o próprio atendimento.
DROP POLICY IF EXISTS atendimentos_select ON public.atendimentos;

CREATE POLICY atendimentos_select ON public.atendimentos
  FOR SELECT
  USING (
    is_member_of(company_id)
    AND (
      can_view_all_in(company_id)
      OR assigned_to = auth.uid()
      OR current_department_id = current_department_in(company_id)
      OR (
        pendentes_abertos_a_todos(company_id)
        AND status = ANY (ARRAY['pendente'::status_atendimento, 'em_triagem'::status_atendimento])
        AND assigned_to IS NULL
      )
    )
  );

-- c1) Nova RPC: substitui o UPDATE cru do frontend em "Atribuir a mim".
-- Resolve departamento, reabre se encerrado, registra timeline e valida
-- permissão de supervisão (tomar para si atendimento de outra pessoa) com o
-- mesmo conjunto de flags que repassar_atendimento já exige.
CREATE OR REPLACE FUNCTION public.assumir_atendimento(p_atendimento_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_company uuid;
  v_assigned_to uuid;
  v_status status_atendimento;
  v_from_dept uuid;
  v_my_dept uuid;
  v_my_role text;
  v_to_dept uuid;
  v_era_encerrado boolean;
  v_is_takeover boolean;
  v_dept_changed boolean;
  v_updated_count int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT company_id, assigned_to, status, current_department_id
    INTO v_company, v_assigned_to, v_status, v_from_dept
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

  IF v_status = 'em_triagem' THEN
    RAISE EXCEPTION 'Atendimento ainda está em triagem' USING ERRCODE = 'P0002';
  END IF;

  -- Já é meu e está aberto: nada a fazer.
  IF v_assigned_to = v_user_id AND v_status <> 'encerrado' THEN
    RETURN false;
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
  v_era_encerrado := (v_status = 'encerrado');
  v_dept_changed := (v_from_dept IS DISTINCT FROM v_to_dept);

  UPDATE public.atendimentos
     SET assigned_to = v_user_id,
         status = 'em_atendimento',
         assigned_at = now(),
         current_department_id = v_to_dept,
         closed_at = NULL,
         closed_by_user_id = NULL,
         close_reason = NULL
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
       'supervisor_action', v_is_takeover
     ));

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.assumir_atendimento(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assumir_atendimento(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.assumir_atendimento(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assumir_atendimento(uuid) TO service_role;

-- c2) repassar_atendimento: encerrado deixa de ser bloqueio e passa a reabrir.
CREATE OR REPLACE FUNCTION public.repassar_atendimento(p_atendimento_id uuid, p_to_user_id uuid, p_observacao text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_assigned_to uuid;
  v_status status_atendimento;
  v_from_dept uuid;
  v_to_user_dept uuid;
  v_to_dept uuid;
  v_to_ativo boolean;
  v_to_is_system boolean;
  v_era_encerrado boolean;
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

  -- Repassar um atendimento encerrado reabre ele para o destino. Só a triagem
  -- em andamento continua fora: lá o bot ainda está roteando.
  IF v_status = 'em_triagem' THEN
    RAISE EXCEPTION 'Atendimento ainda está em triagem' USING ERRCODE = 'P0002';
  END IF;

  v_era_encerrado := (v_status = 'encerrado');

  IF p_to_user_id = v_assigned_to AND NOT v_era_encerrado THEN
    RAISE EXCEPTION 'Atendimento já está com este colaborador' USING ERRCODE = '22023';
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
         transferred_count = transferred_count + 1
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
       'supervisor_action', v_is_supervisor,
       'destino_sem_departamento', v_to_user_dept IS NULL
     ));

  RETURN true;
END;
$function$;
