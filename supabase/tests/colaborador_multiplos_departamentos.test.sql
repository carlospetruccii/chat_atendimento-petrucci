-- Teste re-executável: colaborador em vários departamentos.
-- Roda contra o banco (via MCP execute_sql, psql, ou Supabase SQL editor).
-- Tudo dentro de BEGIN/ROLLBACK: nada fica gravado. Usa um colaborador ativo
-- (não admin) e um atendimento já atribuído a OUTRA pessoa num setor diferente
-- do dele. Levanta EXCEPTION no primeiro caso que divergir; o SELECT final só
-- aparece se todos passarem.
BEGIN;

DO $$
DECLARE
  v_user uuid;
  v_company uuid;
  v_d1 uuid;          -- setor atual do colaborador
  v_d2 uuid;          -- setor de um atendimento de outra pessoa
  v_d3 uuid;          -- um terceiro setor, fora da lista
  v_atend uuid;
  v_admin uuid;       -- administrador (não dono) sem setor
  v_n int;
  v_ids uuid[];
BEGIN
  -- 0) Carga inicial: todo users.department_id virou linha em user_departments.
  SELECT count(*) INTO v_n
    FROM public.users u
   WHERE u.department_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.user_departments ud
                      WHERE ud.user_id = u.id AND ud.department_id = u.department_id);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALHOU [carga]: % pessoas sem o setor principal na lista', v_n;
  END IF;

  SELECT u.id, m.company_id, u.department_id
    INTO v_user, v_company, v_d1
    FROM public.users u
    JOIN public.company_members m ON m.user_id = u.id AND m.ativo
   WHERE u.ativo AND NOT u.is_superadmin AND NOT u.is_system_user
     AND u.department_id IS NOT NULL
   ORDER BY u.created_at
   LIMIT 1;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'FALHOU [setup]: precisa de um colaborador ativo com departamento';
  END IF;

  SELECT a.id, a.current_department_id INTO v_atend, v_d2
    FROM public.atendimentos a
   WHERE a.company_id = v_company
     AND a.current_department_id IS NOT NULL
     AND a.current_department_id <> v_d1
     AND a.assigned_to IS NOT NULL
     AND a.assigned_to <> v_user
     AND a.status IN ('em_atendimento', 'reservado', 'encerrado')
     -- Fora do histórico dele (participante enxerga por outra policy).
     AND NOT EXISTS (SELECT 1 FROM public.timeline_events t
                      WHERE t.atendimento_id = a.id
                        AND (t.actor_user_id = v_user OR t.target_user_id = v_user))
   LIMIT 1;
  IF v_atend IS NULL THEN
    RAISE EXCEPTION 'FALHOU [setup]: precisa de um atendimento atribuído em outro setor';
  END IF;

  SELECT d.id INTO v_d3 FROM public.departments d
   WHERE d.company_id = v_company AND d.id NOT IN (v_d1, v_d2)
   LIMIT 1;
  IF v_d3 IS NULL THEN
    RAISE EXCEPTION 'FALHOU [setup]: precisa de 3 departamentos';
  END IF;

  -- 1) Só com d1: não vê o atendimento de d2.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.atendimentos WHERE id = v_atend;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALHOU [antes]: colaborador já via o atendimento de outro setor';
  END IF;

  -- 2) Colaborador não define os próprios setores.
  BEGIN
    PERFORM public.definir_departamentos_usuario(v_user, ARRAY[v_d1, v_d2]);
    RAISE EXCEPTION 'FALHOU [permissao]: colaborador mudou os próprios setores';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- esperado
  END;

  -- 3) Nem escreve direto na tabela.
  BEGIN
    INSERT INTO public.user_departments (user_id, department_id) VALUES (v_user, v_d2);
    RAISE EXCEPTION 'FALHOU [insert direto]: colaborador inseriu setor';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- esperado
  END;
  RESET ROLE;

  -- 4) Define d1 + d2 (como service_role: sem auth.uid()).
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM public.definir_departamentos_usuario(v_user, ARRAY[v_d1, v_d2, v_d2, NULL]);
  SELECT array_agg(department_id ORDER BY department_id) INTO v_ids
    FROM public.user_departments WHERE user_id = v_user;
  IF v_ids IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[v_d1, v_d2]) x) THEN
    RAISE EXCEPTION 'FALHOU [definir]: lista ficou %', v_ids;
  END IF;
  IF (SELECT department_id FROM public.users WHERE id = v_user) IS DISTINCT FROM v_d1 THEN
    RAISE EXCEPTION 'FALHOU [principal]: principal não é o 1º da lista';
  END IF;
  IF (SELECT department_id FROM public.company_members
       WHERE user_id = v_user AND company_id = v_company) IS DISTINCT FROM v_d1 THEN
    RAISE EXCEPTION 'FALHOU [espelho]: company_members não acompanhou o principal';
  END IF;

  -- 5) Agora vê o atendimento de d2.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.atendimentos WHERE id = v_atend;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FALHOU [visibilidade]: não vê atendimento do 2º setor';
  END IF;
  RESET ROLE;

  -- 6) Para onde vai o atendimento: fica se a pessoa é do setor, senão principal.
  IF public.departamento_para_responsavel(v_user, v_d2) IS DISTINCT FROM v_d2 THEN
    RAISE EXCEPTION 'FALHOU [destino d2]: devia continuar em d2';
  END IF;
  IF public.departamento_para_responsavel(v_user, v_d3) IS DISTINCT FROM v_d1 THEN
    RAISE EXCEPTION 'FALHOU [destino d3]: devia ir para o principal';
  END IF;
  IF public.departamento_para_responsavel(v_user, NULL) IS DISTINCT FROM v_d1 THEN
    RAISE EXCEPTION 'FALHOU [destino null]: devia ir para o principal';
  END IF;

  -- 7) Colaborador sem nenhum setor é recusado.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.definir_departamentos_usuario(v_user, '{}');
    RAISE EXCEPTION 'FALHOU [vazio]: colaborador ficou sem setor';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL; -- esperado
  END;

  -- 8) Escritor antigo trocando "o" departamento: a lista vira só ele.
  UPDATE public.users SET department_id = v_d3 WHERE id = v_user;
  SELECT array_agg(department_id) INTO v_ids
    FROM public.user_departments WHERE user_id = v_user;
  IF v_ids IS DISTINCT FROM ARRAY[v_d3] THEN
    RAISE EXCEPTION 'FALHOU [legado]: lista ficou %', v_ids;
  END IF;

  -- 9) Troca de papel com lista (edge function) e a versão antiga (um setor).
  PERFORM public.alterar_papel_membro(v_user, v_company, false, ARRAY[v_d2, v_d1]);
  IF (SELECT department_id FROM public.users WHERE id = v_user) IS DISTINCT FROM v_d2
     OR (SELECT count(*) FROM public.user_departments WHERE user_id = v_user) <> 2 THEN
    RAISE EXCEPTION 'FALHOU [papel lista]: setores não aplicados';
  END IF;
  PERFORM public.alterar_papel_membro(v_user, v_company, false, v_d1);
  SELECT array_agg(department_id) INTO v_ids
    FROM public.user_departments WHERE user_id = v_user;
  IF v_ids IS DISTINCT FROM ARRAY[v_d1] THEN
    RAISE EXCEPTION 'FALHOU [papel antigo]: lista ficou %', v_ids;
  END IF;


  -- 10) Setor que não existe (ou de outra empresa) é recusado.
  BEGIN
    PERFORM public.definir_departamentos_usuario(v_user, ARRAY[gen_random_uuid()]);
    RAISE EXCEPTION 'FALHOU [setor invalido]: aceitou setor inexistente';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL; -- esperado
  END;

  -- 11) Admin sem setor rebaixado a colaborador com setores (CHECK de
  --     company_members exige setor para colaborador: ordem importa).
  SELECT u.id INTO v_admin
    FROM public.users u
    JOIN public.company_members m ON m.user_id = u.id AND m.ativo
   WHERE u.ativo AND u.is_superadmin AND NOT u.is_system_user
     AND m.role = 'administrador' AND m.company_id = v_company
   LIMIT 1;
  IF v_admin IS NOT NULL THEN
    PERFORM public.alterar_papel_membro(v_admin, v_company, true, '{}'::uuid[]);
    PERFORM public.alterar_papel_membro(v_admin, v_company, false, ARRAY[v_d1, v_d2]);
    IF (SELECT role FROM public.company_members
         WHERE user_id = v_admin AND company_id = v_company) <> 'colaborador'
       OR (SELECT count(*) FROM public.user_departments WHERE user_id = v_admin) <> 2 THEN
      RAISE EXCEPTION 'FALHOU [rebaixar admin]: papel/setores não aplicados';
    END IF;
    -- E volta a admin sem setor.
    PERFORM public.alterar_papel_membro(v_admin, v_company, true, '{}'::uuid[]);
    IF EXISTS (SELECT 1 FROM public.user_departments WHERE user_id = v_admin) THEN
      RAISE EXCEPTION 'FALHOU [promover admin]: ficou com setor';
    END IF;

    -- 12) Quem não é dono não muda setor de administrador, nem por UPDATE direto.
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      UPDATE public.users SET department_id = v_d1
       WHERE id = (SELECT m.user_id FROM public.company_members m
                    WHERE m.company_id = v_company AND m.role = 'dono' LIMIT 1);
      RAISE EXCEPTION 'FALHOU [setor do dono]: admin não-dono mudou setor do dono';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL; -- esperado
    END;
    RESET ROLE;
  END IF;
END $$;

SELECT 'OK: colaborador_multiplos_departamentos' AS resultado;

ROLLBACK;
