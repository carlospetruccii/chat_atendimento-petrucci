-- Colaborador em vários departamentos.
--
-- Antes: cada pessoa tinha UM departamento (users.department_id, espelhado em
-- company_members.department_id). Visibilidade (RLS), fila, avisos de pendente,
-- repasse e continuidade usavam esse único valor.
--
-- Agora: public.user_departments guarda TODOS os setores da pessoa (0..N).
--   - users.department_id continua existindo como "departamento principal"
--     (o 1º da lista). Telas que só mostram um nome e escritores antigos seguem
--     funcionando. Um trigger mantém a tabela nova coerente com ele:
--       principal → NULL           ⇒ a pessoa fica sem nenhum setor;
--       principal fora da lista    ⇒ a lista vira só ele (escritor antigo, que
--                                    troca "o" departamento);
--       principal já na lista      ⇒ nada muda.
--     O mesmo trigger espelha o principal em company_members.department_id
--     (antes a edição de colaborador pela tela não espelhava).
--   - Visibilidade: vê o atendimento quem está em QUALQUER setor dele.
--   - Quem pega/recebe um atendimento: se o setor atual do atendimento é um dos
--     setores da pessoa, ele fica onde está; senão vai para o principal dela.
--     Para quem tem um setor só, é exatamente a regra antiga.
--   - repassar_atendimento aceita o setor de destino (opcional), validado contra
--     os setores do destinatário.
--
-- Escrita dos setores: definir_departamentos_usuario (tela) e
-- alterar_papel_membro (edge function de troca de papel, service_role).
--
-- Idempotente: CREATE IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1) Tabela pessoa ↔ setores
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_departments (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, department_id)
);

CREATE INDEX IF NOT EXISTS idx_user_departments_department
  ON public.user_departments (department_id);

ALTER TABLE public.user_departments ENABLE ROW LEVEL SECURITY;

-- Leitura: membros da empresa do setor (users já é legível por qualquer
-- autenticado; aqui fica restrito à empresa). Escrita só pelas funções abaixo.
DROP POLICY IF EXISTS user_departments_select ON public.user_departments;
CREATE POLICY user_departments_select ON public.user_departments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.departments d
       WHERE d.id = user_departments.department_id
         AND public.is_member_of(d.company_id)
    )
  );

REVOKE INSERT, UPDATE, DELETE ON public.user_departments FROM anon, authenticated;

-- Carga inicial: o departamento atual de cada pessoa.
INSERT INTO public.user_departments (user_id, department_id)
SELECT u.id, u.department_id
  FROM public.users u
 WHERE u.department_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2) Trigger: principal (users.department_id) ↔ lista ↔ company_members
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.users_sincronizar_departamentos()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.department_id IS NOT DISTINCT FROM NEW.department_id THEN
    RETURN NULL;
  END IF;

  IF NEW.department_id IS NULL THEN
    DELETE FROM public.user_departments WHERE user_id = NEW.id;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.user_departments
     WHERE user_id = NEW.id AND department_id = NEW.department_id
  ) THEN
    DELETE FROM public.user_departments WHERE user_id = NEW.id;
    INSERT INTO public.user_departments (user_id, department_id)
    VALUES (NEW.id, NEW.department_id);
  END IF;

  -- Só no vínculo da empresa do setor (FK composta department_id+company_id).
  UPDATE public.company_members m
     SET department_id = NEW.department_id
   WHERE m.user_id = NEW.id
     AND m.department_id IS DISTINCT FROM NEW.department_id
     AND (NEW.department_id IS NULL
          OR m.company_id = (SELECT d.company_id FROM public.departments d
                              WHERE d.id = NEW.department_id));

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_sincronizar_departamentos ON public.users;
CREATE TRIGGER trg_users_sincronizar_departamentos
  AFTER INSERT OR UPDATE OF department_id ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_sincronizar_departamentos();

REVOKE EXECUTE ON FUNCTION public.users_sincronizar_departamentos() FROM PUBLIC, anon, authenticated;

-- Mesmo guard de definir_departamentos_usuario para quem grava
-- users.department_id direto (a policy deixa admin/manage_users atualizar
-- qualquer linha): setor de administrador só o dono muda. Resto da função
-- igual à de 20261008180000.
CREATE OR REPLACE FUNCTION public.protect_superadmin_flag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_is_admin boolean;
BEGIN
  IF v_uid IS NOT NULL THEN
    IF v_uid = OLD.id AND NEW.ativo IS DISTINCT FROM OLD.ativo THEN
      RAISE EXCEPTION 'Ninguém pode ativar ou desativar o próprio acesso'
        USING ERRCODE = '42501';
    END IF;

    IF OLD.ativo AND NOT NEW.ativo THEN
      IF EXISTS (SELECT 1 FROM public.company_members m
                  WHERE m.user_id = OLD.id AND m.role = 'dono') THEN
        RAISE EXCEPTION 'O dono da empresa não pode ser desativado'
          USING ERRCODE = '42501';
      END IF;
      IF OLD.is_superadmin AND NOT current_user_is_superadmin() THEN
        RAISE EXCEPTION 'Só um administrador pode desativar outro administrador'
          USING ERRCODE = '42501';
      END IF;
      IF OLD.is_superadmin AND NOT EXISTS (
           SELECT 1 FROM public.users u
            WHERE u.id <> OLD.id AND u.ativo AND u.is_superadmin
              AND NOT coalesce(u.is_system_user, false)) THEN
        RAISE EXCEPTION 'Não dá para desativar o último administrador ativo'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    v_is_admin := current_user_is_superadmin() OR has_permission('manage_users');
    IF NOT v_is_admin THEN
      IF NEW.is_superadmin IS DISTINCT FROM OLD.is_superadmin
         OR NEW.is_system_user IS DISTINCT FROM OLD.is_system_user
         OR NEW.department_id IS DISTINCT FROM OLD.department_id
         OR NEW.ativo IS DISTINCT FROM OLD.ativo THEN
        RAISE EXCEPTION 'Sem permissao para alterar campos administrativos do usuario'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF OLD.is_superadmin
       AND NEW.department_id IS DISTINCT FROM OLD.department_id
       AND NOT EXISTS (SELECT 1 FROM public.company_members m
                        WHERE m.user_id = v_uid AND m.role = 'dono' AND m.ativo = true) THEN
      RAISE EXCEPTION 'Só o dono altera os departamentos de um administrador'
        USING ERRCODE = '42501';
    END IF;

    IF OLD.is_superadmin = true AND NEW.is_superadmin IS DISTINCT FROM OLD.is_superadmin THEN
      RAISE EXCEPTION 'is_superadmin e imutavel apos ser definido como TRUE';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3) Helpers
-- ---------------------------------------------------------------------------

-- Setores do usuário logado (usado nas policies). Sem argumento de linha de
-- propósito: nas policies vai como `= ANY ((SELECT public.meus_departamentos())::uuid[])`,
-- que o Postgres calcula UMA vez por consulta (InitPlan), não por linha. A
-- empresa já fica garantida: o setor do atendimento/mensagem é da empresa da
-- linha (FK composta) e a policy exige is_member_of(company_id), que checa o
-- vínculo ativo.
CREATE OR REPLACE FUNCTION public.meus_departamentos()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(array_agg(ud.department_id), '{}')
    FROM public.user_departments ud
   WHERE ud.user_id = auth.uid()
$$;

-- Para onde vai o atendimento quando p_user_id fica com ele: continua no setor
-- atual se a pessoa é desse setor; senão vai para o principal dela; sem
-- principal, continua onde está.
CREATE OR REPLACE FUNCTION public.departamento_para_responsavel(p_user_id uuid, p_dept_atual uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_dept_atual IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.user_departments ud
       WHERE ud.user_id = p_user_id AND ud.department_id = p_dept_atual
    ) THEN p_dept_atual
    ELSE COALESCE(
      (SELECT u.department_id FROM public.users u WHERE u.id = p_user_id),
      p_dept_atual
    )
  END
$$;

REVOKE EXECUTE ON FUNCTION public.departamento_para_responsavel(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) Escrita dos setores de uma pessoa
-- ---------------------------------------------------------------------------
-- A ordem importa: o 1º vira o principal. Nulos e repetidos são ignorados.
-- Pela tela (auth.uid() presente): precisa ser admin ou ter manage_users; os
-- setores de um administrador só o dono muda (mesma regra da tela e da troca
-- de papel). Colaborador precisa de pelo menos um setor.
CREATE OR REPLACE FUNCTION public.definir_departamentos_usuario(
  p_user_id uuid,
  p_department_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_is_admin boolean;
  v_is_system boolean;
  v_invalidos int;
BEGIN
  SELECT is_superadmin, is_system_user INTO v_is_admin, v_is_system
    FROM public.users WHERE id = p_user_id;
  IF NOT FOUND OR v_is_system THEN
    RAISE EXCEPTION 'Colaborador não encontrado' USING ERRCODE = 'P0002';
  END IF;

  IF v_uid IS NOT NULL THEN
    IF NOT (public.current_user_is_superadmin() OR public.has_permission('manage_users')) THEN
      RAISE EXCEPTION 'Sem permissão para alterar departamentos' USING ERRCODE = '42501';
    END IF;
    IF v_is_admin AND NOT EXISTS (
      SELECT 1 FROM public.company_members m
       WHERE m.user_id = v_uid AND m.role = 'dono' AND m.ativo = true
    ) THEN
      RAISE EXCEPTION 'Só o dono altera os departamentos de um administrador'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT coalesce(array_agg(x.d ORDER BY x.ord), '{}') INTO v_ids
    FROM (
      SELECT t.d, min(t.ord) AS ord
        FROM unnest(coalesce(p_department_ids, '{}')) WITH ORDINALITY AS t(d, ord)
       WHERE t.d IS NOT NULL
       GROUP BY t.d
    ) x;

  IF NOT v_is_admin AND cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'Colaborador precisa de pelo menos um departamento'
      USING ERRCODE = '22023';
  END IF;

  -- Cada setor precisa existir e ser de uma empresa da pessoa.
  SELECT count(*) INTO v_invalidos
    FROM unnest(v_ids) AS x(d)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.departments dp
       JOIN public.company_members m ON m.company_id = dp.company_id
      WHERE dp.id = x.d AND m.user_id = p_user_id
   );
  IF v_invalidos > 0 THEN
    RAISE EXCEPTION 'Departamento inválido' USING ERRCODE = '22023';
  END IF;

  -- Principal primeiro: o trigger ajusta company_members e garante que ele
  -- está na lista. Depois a lista é igualada ao pedido.
  UPDATE public.users SET department_id = v_ids[1] WHERE id = p_user_id;

  DELETE FROM public.user_departments
   WHERE user_id = p_user_id
     AND NOT (department_id = ANY (v_ids));

  INSERT INTO public.user_departments (user_id, department_id)
  SELECT p_user_id, d FROM unnest(v_ids) AS d
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.definir_departamentos_usuario(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.definir_departamentos_usuario(uuid, uuid[]) TO authenticated, service_role;

-- Troca de papel (edge function alterar-papel-colaborador, service_role) com a
-- lista de setores.
CREATE OR REPLACE FUNCTION public.alterar_papel_membro(
  p_user_id uuid,
  p_company_id uuid,
  p_is_admin boolean,
  p_department_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_role public.company_role := CASE WHEN p_is_admin THEN 'administrador' ELSE 'colaborador' END;
BEGIN
  UPDATE public.users
     SET is_superadmin = p_is_admin
   WHERE id = p_user_id
     AND is_system_user = false;

  -- A CHECK company_members_colaborador_dept_chk exige setor para colaborador:
  -- ao virar colaborador, grava os setores ANTES do papel; ao virar admin
  -- (pode ficar sem setor), o papel antes dos setores.
  IF p_is_admin THEN
    UPDATE public.company_members
       SET role = v_role
     WHERE user_id = p_user_id AND company_id = p_company_id AND ativo = true;
    PERFORM public.definir_departamentos_usuario(p_user_id, p_department_ids);
  ELSE
    PERFORM public.definir_departamentos_usuario(p_user_id, p_department_ids);
    UPDATE public.company_members
       SET role = v_role
     WHERE user_id = p_user_id AND company_id = p_company_id AND ativo = true;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.alterar_papel_membro(uuid, uuid, boolean, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.alterar_papel_membro(uuid, uuid, boolean, uuid[]) TO service_role;

-- Versão antiga (um setor), mantida para a edge function ainda não atualizada.
CREATE OR REPLACE FUNCTION public.alterar_papel_membro(
  p_user_id uuid,
  p_company_id uuid,
  p_is_admin boolean,
  p_department_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM public.alterar_papel_membro(
    p_user_id, p_company_id, p_is_admin,
    CASE WHEN p_department_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[p_department_id] END
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.alterar_papel_membro(uuid, uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.alterar_papel_membro(uuid, uuid, boolean, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5) Visibilidade: qualquer setor da pessoa
-- ---------------------------------------------------------------------------
ALTER POLICY atendimentos_select ON public.atendimentos
  USING (
    is_member_of(company_id)
    AND (
      can_view_all_in(company_id)
      OR assigned_to = auth.uid()
      OR current_department_id = ANY ((SELECT public.meus_departamentos())::uuid[])
      OR (
        pendentes_abertos_a_todos(company_id)
        AND status = ANY (ARRAY['pendente'::status_atendimento, 'em_triagem'::status_atendimento])
        AND assigned_to IS NULL
      )
    )
  );

ALTER POLICY mensagens_select ON public.mensagens
  USING (
    is_member_of(company_id)
    AND (
      can_view_all_in(company_id)
      OR department_id = ANY ((SELECT public.meus_departamentos())::uuid[])
      OR (
        pendentes_abertos_a_todos(company_id)
        AND EXISTS (
          SELECT 1 FROM atendimentos a
           WHERE a.id = mensagens.atendimento_id
             AND a.assigned_to IS NULL
             AND a.status = ANY (ARRAY['pendente'::status_atendimento, 'em_triagem'::status_atendimento])
        )
      )
    )
  );

ALTER POLICY timeline_events_select ON public.timeline_events
  USING (
    is_member_of(company_id)
    AND (
      can_view_all_in(company_id)
      OR EXISTS (
        SELECT 1 FROM atendimentos a
         WHERE a.id = timeline_events.atendimento_id
           AND a.current_department_id = ANY ((SELECT public.meus_departamentos())::uuid[])
      )
    )
  );

-- Espelho da mensagens_select para a mídia (ver 20261016132017).
CREATE OR REPLACE FUNCTION public.mensagem_midia_visivel(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.mensagens m
    WHERE (m.media_metadata ->> 'storage_path') = p_name
      AND (
        (
          public.is_member_of(m.company_id)
          AND (
            public.can_view_all_in(m.company_id)
            OR m.department_id = ANY ((SELECT public.meus_departamentos())::uuid[])
            OR (
              public.pendentes_abertos_a_todos(m.company_id)
              AND EXISTS (
                SELECT 1
                FROM public.atendimentos a
                WHERE a.id = m.atendimento_id
                  AND a.assigned_to IS NULL
                  AND a.status = ANY (ARRAY['pendente'::public.status_atendimento, 'em_triagem'::public.status_atendimento])
              )
            )
          )
        )
        OR private.can_read_atendimento_participante(m.atendimento_id, m.company_id)
      )
  )
$function$;

-- ---------------------------------------------------------------------------
-- 6) Quem pega / recebe atendimento
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_pendente(p_atendimento_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_old_dept uuid;
  v_new_dept uuid;
  v_dept_changed boolean;
  v_updated_count int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  SELECT current_department_id INTO v_old_dept FROM public.atendimentos WHERE id = p_atendimento_id;

  v_new_dept := public.departamento_para_responsavel(v_user_id, v_old_dept);
  v_dept_changed := (v_old_dept IS DISTINCT FROM v_new_dept);

  UPDATE public.atendimentos
     SET assigned_to = v_user_id,
         status = 'reservado',
         assigned_at = now(),
         current_department_id = v_new_dept,
         transferred_count = transferred_count + CASE WHEN v_dept_changed THEN 1 ELSE 0 END
   WHERE id = p_atendimento_id
     AND assigned_to IS NULL;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count = 0 THEN
    RETURN false;
  END IF;

  -- Carimba mensagens órfãs (não toca em mensagens já carimbadas)
  UPDATE public.mensagens
     SET department_id = v_new_dept
   WHERE atendimento_id = p_atendimento_id
     AND department_id IS NULL;

  INSERT INTO public.timeline_events
    (atendimento_id, tipo_evento, actor_user_id, target_user_id,
     from_department_id, to_department_id, payload)
  VALUES
    (p_atendimento_id, 'reservado', v_user_id, v_user_id,
     v_old_dept, v_new_dept,
     jsonb_build_object(
       'origem', 'claim_pendente',
       'dept_alterado', v_dept_changed
     ));

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.assign_pendente_a_usuario(p_atendimento_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  SELECT ativo, is_system_user
    INTO v_to_ativo, v_to_is_system
    FROM public.users
   WHERE id = p_user_id;

  IF NOT FOUND OR v_to_ativo = false OR v_to_is_system = true THEN
    RAISE EXCEPTION 'Colaborador destino inválido' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.user_departments WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'Colaborador destino sem departamento' USING ERRCODE = '22023';
  END IF;

  SELECT current_department_id INTO v_old_dept
    FROM public.atendimentos
   WHERE id = p_atendimento_id;

  v_to_dept := public.departamento_para_responsavel(p_user_id, v_old_dept);
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
$function$;

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

  SELECT m.role
    INTO v_my_role
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
  v_to_dept := public.departamento_para_responsavel(v_user_id, v_from_dept);
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

-- Repasse com setor de destino opcional. Assinatura nova (4º parâmetro com
-- DEFAULT): a antiga sai para o PostgREST não ficar com duas candidatas.
DROP FUNCTION IF EXISTS public.repassar_atendimento(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.repassar_atendimento(
  p_atendimento_id uuid,
  p_to_user_id uuid,
  p_observacao text DEFAULT NULL::text,
  p_department_id uuid DEFAULT NULL::uuid
)
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
  v_to_dept uuid;
  v_to_ativo boolean;
  v_to_is_system boolean;
  v_to_sem_dept boolean;
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

  SELECT ativo, is_system_user
    INTO v_to_ativo, v_to_is_system
    FROM public.users
   WHERE id = p_to_user_id;

  IF NOT FOUND OR v_to_ativo = false OR v_to_is_system = true THEN
    RAISE EXCEPTION 'Colaborador destino inválido' USING ERRCODE = '22023';
  END IF;

  v_to_sem_dept := NOT EXISTS (
    SELECT 1 FROM public.user_departments WHERE user_id = p_to_user_id
  );

  -- Setor escolhido na tela: precisa ser um dos setores do destino.
  IF p_department_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.user_departments
       WHERE user_id = p_to_user_id AND department_id = p_department_id
    ) THEN
      RAISE EXCEPTION 'Colaborador não pertence a este departamento' USING ERRCODE = '22023';
    END IF;
    v_to_dept := p_department_id;
  ELSE
    -- O departamento segue a pessoa: fica no atual se ela é de lá, senão vai
    -- para o principal dela. Pode terminar NULL (destino sem departamento e
    -- atendimento vindo da triagem) — a CHECK aceita, porque assigned_to fica
    -- preenchido.
    v_to_dept := public.departamento_para_responsavel(p_to_user_id, v_from_dept);
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
       'destino_sem_departamento', v_to_sem_dept
     ));

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.repassar_atendimento(uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.repassar_atendimento(uuid, uuid, text, uuid) TO authenticated, service_role;

-- Continuidade: o último atendente só vale se ainda é do setor consultado (ou
-- é admin sem nenhum setor, que atende qualquer um).
CREATE OR REPLACE FUNCTION public.ultimo_atendente_no_departamento(p_client_id uuid, p_department_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT a.assigned_to
  FROM public.atendimentos a
  JOIN public.users u ON u.id = a.assigned_to
  WHERE a.client_id = p_client_id
    AND a.current_department_id = p_department_id
    AND a.status = 'encerrado'
    AND a.assigned_to IS NOT NULL
    AND u.ativo = true
    AND u.disponivel = true
    AND u.is_system_user = false
    AND (
      EXISTS (
        SELECT 1 FROM public.user_departments ud
         WHERE ud.user_id = u.id AND ud.department_id = p_department_id
      )
      OR (
        u.is_superadmin = true
        AND NOT EXISTS (SELECT 1 FROM public.user_departments ud WHERE ud.user_id = u.id)
      )
    )
  ORDER BY a.closed_at DESC NULLS LAST
  LIMIT 1
$function$;
