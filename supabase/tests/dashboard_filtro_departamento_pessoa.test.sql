-- Teste re-executável do filtro por departamento e por pessoa da dashboard
-- (migration 20260917173311_dashboard_filtro_departamento_pessoa).
--
-- Cobre:
--   1) o trigger carimba first_response_user_id com quem mandou a 1ª mensagem
--      de atendente — e não troca quando outra pessoa responde depois;
--   2) dashboard_relacionamento(p_from, p_to, p_department_id, p_user_id)
--      filtra primeira resposta, sem resposta, transferências e iniciativa;
--   3) a assinatura antiga (2 argumentos) continua respondendo.
--
-- As fixtures ficam em 2099 pra não misturar com dado real no período.
-- Roda dentro de BEGIN/ROLLBACK. Levanta EXCEPTION no primeiro caso divergente.
BEGIN;

DO $$
DECLARE
  v_company uuid;
  v_user_a  uuid;
  v_user_b  uuid;
  v_dept_a  uuid;
  v_dept_b  uuid;
  v_cli     uuid[] := ARRAY[]::uuid[];
  v_at1     uuid;  -- dept A, respondido por A (e depois por B)
  v_at2     uuid;  -- dept B, respondido por B
  v_at3     uuid;  -- dept A, sem resposta, com B
  v_resp    uuid;
  v_r       jsonb;
  c_from constant timestamptz := '2099-01-05 00:00:00-03';
  c_to   constant timestamptz := '2099-01-05 23:59:59-03';
  i int;
BEGIN
  SELECT id INTO v_company FROM public.companies ORDER BY created_at LIMIT 1;

  SELECT cm.user_id INTO v_user_a FROM public.company_members cm
   WHERE cm.company_id = v_company AND cm.ativo ORDER BY cm.created_at LIMIT 1;
  SELECT cm.user_id INTO v_user_b FROM public.company_members cm
   WHERE cm.company_id = v_company AND cm.ativo AND cm.user_id <> v_user_a
   ORDER BY cm.created_at LIMIT 1;
  SELECT id INTO v_dept_a FROM public.departments WHERE ativo ORDER BY nome LIMIT 1;
  SELECT id INTO v_dept_b FROM public.departments WHERE ativo AND id <> v_dept_a ORDER BY nome LIMIT 1;

  IF v_company IS NULL OR v_user_a IS NULL OR v_user_b IS NULL OR v_dept_a IS NULL OR v_dept_b IS NULL THEN
    RAISE EXCEPTION 'FIXTURE: precisa de 1 empresa, 2 membros ativos e 2 departamentos ativos';
  END IF;

  -- Inserir mensagem é só do servidor.
  SET LOCAL ROLE service_role;

  FOR i IN 1..3 LOOP
    INSERT INTO public.clients (numero_whatsapp, nome, company_id)
    VALUES ('+55990000000' || i, 'TESTE filtro dashboard ' || i, v_company)
    RETURNING id INTO v_resp;
    v_cli := v_cli || v_resp;
  END LOOP;

  INSERT INTO public.atendimentos
    (client_id, company_id, status, current_department_id, assigned_to, assigned_at, created_at)
  VALUES (v_cli[1], v_company, 'reservado', v_dept_a, v_user_a, '2099-01-05 10:00-03', '2099-01-05 10:00-03')
  RETURNING id INTO v_at1;
  INSERT INTO public.atendimentos
    (client_id, company_id, status, current_department_id, assigned_to, assigned_at, created_at)
  VALUES (v_cli[2], v_company, 'reservado', v_dept_b, v_user_b, '2099-01-05 11:00-03', '2099-01-05 11:00-03')
  RETURNING id INTO v_at2;
  INSERT INTO public.atendimentos
    (client_id, company_id, status, current_department_id, assigned_to, assigned_at, created_at)
  VALUES (v_cli[3], v_company, 'reservado', v_dept_a, v_user_b, '2099-01-05 12:00-03', '2099-01-05 12:00-03')
  RETURNING id INTO v_at3;

  INSERT INTO public.mensagens
    (atendimento_id, client_id, company_id, department_id, direction, sender_type, sent_by_user_id, tipo, content, created_at)
  VALUES
    (v_at1, v_cli[1], v_company, v_dept_a, 'inbound',  'cliente',   NULL,     'texto', 'oi', '2099-01-05 10:00-03'),
    (v_at1, v_cli[1], v_company, v_dept_a, 'outbound', 'atendente', v_user_a, 'texto', 'olá', '2099-01-05 10:05-03'),
    (v_at1, v_cli[1], v_company, v_dept_a, 'outbound', 'atendente', v_user_b, 'texto', 'eu também', '2099-01-05 10:06-03'),
    (v_at2, v_cli[2], v_company, v_dept_b, 'inbound',  'cliente',   NULL,     'texto', 'oi', '2099-01-05 11:00-03'),
    (v_at2, v_cli[2], v_company, v_dept_b, 'outbound', 'atendente', v_user_b, 'texto', 'olá', '2099-01-05 11:10-03'),
    (v_at3, v_cli[3], v_company, v_dept_a, 'inbound',  'cliente',   NULL,     'texto', 'oi', '2099-01-05 12:00-03');

  RESET ROLE;

  ---------------------------------------------------------------------------
  -- 1) Trigger: primeira resposta é de A, mesmo com B respondendo depois.
  ---------------------------------------------------------------------------
  SELECT first_response_user_id INTO v_resp FROM public.atendimentos WHERE id = v_at1;
  IF v_resp IS DISTINCT FROM v_user_a THEN
    RAISE EXCEPTION 'CASO 1: at1 deveria ser de A, veio %', v_resp;
  END IF;
  SELECT first_response_user_id INTO v_resp FROM public.atendimentos WHERE id = v_at3;
  IF v_resp IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 1: at3 não foi respondido e veio com %', v_resp;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a)::text, true);

  ---------------------------------------------------------------------------
  -- 2) Sem filtro: 2 respondidos, 1 sem resposta, 3 conversas.
  ---------------------------------------------------------------------------
  v_r := public.dashboard_relacionamento(c_from, c_to, NULL, NULL);
  IF (v_r->'primeira_resposta'->>'total')::int <> 2
     OR (v_r->'primeira_resposta'->>'sem_resposta')::int <> 1
     OR (v_r->'transferencias'->>'conversas')::int <> 3
     OR (v_r->'iniciativa'->>'total')::int <> 3 THEN
    RAISE EXCEPTION 'CASO 2 (sem filtro): %', v_r->'primeira_resposta';
  END IF;

  ---------------------------------------------------------------------------
  -- 3) Departamento A: at1 respondido + at3 sem resposta.
  ---------------------------------------------------------------------------
  v_r := public.dashboard_relacionamento(c_from, c_to, v_dept_a, NULL);
  IF (v_r->'primeira_resposta'->>'total')::int <> 1
     OR (v_r->'primeira_resposta'->>'sem_resposta')::int <> 1
     OR (v_r->'transferencias'->>'conversas')::int <> 2 THEN
    RAISE EXCEPTION 'CASO 3 (dept A): %', v_r;
  END IF;

  ---------------------------------------------------------------------------
  -- 4) Pessoa B: respondeu at2 primeiro; at1 é de A; at3 sem resposta está
  --    com B e conta como "sem resposta" dela.
  ---------------------------------------------------------------------------
  v_r := public.dashboard_relacionamento(c_from, c_to, NULL, v_user_b);
  IF (v_r->'primeira_resposta'->>'total')::int <> 1
     OR (v_r->'primeira_resposta'->>'media_min')::numeric IS NULL
     OR (v_r->'primeira_resposta'->>'sem_resposta')::int <> 1
     OR (v_r->'transferencias'->>'conversas')::int <> 1 THEN
    RAISE EXCEPTION 'CASO 4 (pessoa B): %', v_r;
  END IF;

  ---------------------------------------------------------------------------
  -- 5) Departamento A + pessoa B: nada respondido, 1 sem resposta.
  ---------------------------------------------------------------------------
  v_r := public.dashboard_relacionamento(c_from, c_to, v_dept_a, v_user_b);
  IF (v_r->'primeira_resposta'->>'total')::int <> 0
     OR (v_r->'primeira_resposta'->>'sem_resposta')::int <> 1 THEN
    RAISE EXCEPTION 'CASO 5 (dept A + pessoa B): %', v_r->'primeira_resposta';
  END IF;

  ---------------------------------------------------------------------------
  -- 6) Assinatura antiga ainda funciona (frontend velho em produção).
  ---------------------------------------------------------------------------
  v_r := public.dashboard_relacionamento(c_from, c_to);
  IF (v_r->'primeira_resposta'->>'total')::int <> 2 THEN
    RAISE EXCEPTION 'CASO 6 (assinatura antiga): %', v_r->'primeira_resposta';
  END IF;

  RAISE NOTICE 'dashboard_filtro_departamento_pessoa: todos os casos OK';
END;
$$;

ROLLBACK;
