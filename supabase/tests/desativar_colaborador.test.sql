-- Teste re-executável: desativar colaborador corta o acesso de verdade.
-- Roda contra o banco (via MCP execute_sql, psql, ou Supabase SQL editor).
-- Tudo dentro de BEGIN/ROLLBACK: ninguém fica desativado de verdade.
-- Usa dois administradores ativos (não donos) da mesma empresa: A desativa B.
-- O dono da empresa é usado no caso "ninguém desativa o dono". Levanta
-- EXCEPTION no primeiro caso que divergir; o SELECT final só aparece se todos
-- passarem.
BEGIN;

DO $$
DECLARE
  v_ids uuid[];
  v_a uuid;
  v_b uuid;
  v_company uuid;
  v_n int;
  v_bool boolean;
  v_ban timestamptz;
  v_dono uuid;
BEGIN
  SELECT m.company_id, array_agg(u.id ORDER BY u.created_at)
    INTO v_company, v_ids
    FROM public.company_members m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.ativo AND u.ativo AND u.is_superadmin AND NOT u.is_system_user
     AND m.role <> 'dono'
   GROUP BY m.company_id
  HAVING count(*) >= 2
   ORDER BY m.company_id
   LIMIT 1;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'FALHOU [setup]: precisa de 2 administradores (não donos) ativos na mesma empresa';
  END IF;
  v_a := v_ids[1];
  v_b := v_ids[2];

  -- 1) A (admin) desativa B.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.users SET ativo = false WHERE id = v_b;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FALHOU [desativar]: admin não conseguiu desativar (linhas=%)', v_n;
  END IF;
  RESET ROLE;

  -- 2) Vínculo com a empresa desligado e login bloqueado no Auth.
  IF EXISTS (SELECT 1 FROM public.company_members WHERE user_id = v_b AND ativo) THEN
    RAISE EXCEPTION 'FALHOU [vinculo]: company_members continua ativo';
  END IF;
  SELECT banned_until INTO v_ban FROM auth.users WHERE id = v_b;
  IF v_ban IS NULL OR v_ban < now() + interval '50 years' THEN
    RAISE EXCEPTION 'FALHOU [ban]: login não bloqueado (banned_until=%)', v_ban;
  END IF;
  IF EXISTS (SELECT 1 FROM auth.sessions WHERE user_id = v_b) THEN
    RAISE EXCEPTION 'FALHOU [sessoes]: sessões de B continuam abertas';
  END IF;

  -- 3) B desativado (com o token que ainda tiver) perde tudo.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  IF public.current_user_is_superadmin() THEN
    RAISE EXCEPTION 'FALHOU [superadmin]: desativado continua admin';
  END IF;
  IF public.is_member_of(v_company) THEN
    RAISE EXCEPTION 'FALHOU [membro]: desativado continua membro';
  END IF;
  SELECT count(*) INTO v_n FROM public.atendimentos;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALHOU [atendimentos]: desativado ainda vê % atendimentos', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.system_config;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALHOU [config]: desativado ainda vê % configs', v_n;
  END IF;

  -- 4) B não consegue se reativar.
  BEGIN
    UPDATE public.users SET ativo = true WHERE id = v_b;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'FALHOU [auto-reativar]: desativado se reativou';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- esperado
  END;
  RESET ROLE;

  -- 5) A não consegue desativar a si mesmo.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE public.users SET ativo = false WHERE id = v_a;
    RAISE EXCEPTION 'FALHOU [auto-desativar]: admin se desativou';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- esperado
  END;

  -- 5b) Desativado perde também as permissões avulsas.
  RESET ROLE;
  -- (B continua desativado desde o passo 1.)
  INSERT INTO public.user_permissions (user_id, permission) VALUES (v_b, 'view_all_departments');
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  IF public.has_permission('view_all_departments') OR public.current_user_can_view_all() THEN
    RAISE EXCEPTION 'FALHOU [permissao]: desativado continua com permissão avulsa';
  END IF;
  RESET ROLE;

  -- 5c) Ninguém desativa o dono pela tela.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT m.user_id INTO v_dono FROM public.company_members m
   WHERE m.company_id = v_company AND m.role = 'dono' AND m.user_id <> v_a LIMIT 1;
  IF v_dono IS NULL THEN
    RAISE EXCEPTION 'FALHOU [setup dono]: nenhum dono visível na empresa';
  END IF;
  BEGIN
    UPDATE public.users SET ativo = false WHERE id = v_dono;
    RAISE EXCEPTION 'FALHOU [dono]: admin desativou o dono';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- esperado
  END;

  -- 6) A reativa B: tudo volta.
  UPDATE public.users SET ativo = true WHERE id = v_b;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FALHOU [reativar]: admin não conseguiu reativar';
  END IF;
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM public.company_members WHERE user_id = v_b AND ativo) THEN
    RAISE EXCEPTION 'FALHOU [reativar vinculo]: company_members não voltou';
  END IF;
  SELECT banned_until INTO v_ban FROM auth.users WHERE id = v_b;
  IF v_ban IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU [reativar ban]: login continua bloqueado';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT public.current_user_is_superadmin() INTO v_bool;
  IF NOT v_bool THEN
    RAISE EXCEPTION 'FALHOU [reativar admin]: B reativado não voltou a ser admin';
  END IF;
  RESET ROLE;
END $$;

SELECT 'desativar_colaborador: TODOS OS CASOS OK' AS resultado;
ROLLBACK;
