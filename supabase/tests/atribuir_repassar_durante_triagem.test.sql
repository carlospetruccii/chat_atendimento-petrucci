-- Teste re-executável de "Atribuir a mim" e "Repassar" com o atendimento AINDA
-- em triagem (migration atribuir_repassar_durante_triagem).
--
-- Antes as duas RPCs recusavam status = 'em_triagem' com P0002. Agora elas
-- aceitam e encerram a triagem junto (triagem_estagio = 'concluida' e
-- triagem_finished_at preenchido), senão o atendimento ficaria humano mas com
-- estágio de bot pendurado.
--
-- Roda dentro de BEGIN/ROLLBACK: não deixa nada no banco (nem timeline_events,
-- que é append-only). Levanta EXCEPTION no primeiro caso que divergir.
BEGIN;

DO $$
DECLARE
  v_company   uuid;
  v_joao      uuid;  -- dono, is_superadmin, SEM departamento
  v_leticia   uuid;  -- administrador, is_superadmin, com departamento
  v_dept_let  uuid;
  v_client    uuid;
  v_atend     uuid;
  v_ok        boolean;
  v_status    status_atendimento;
  v_assigned  uuid;
  v_dept      uuid;
  v_estagio   triagem_estagio;
  v_finished  timestamptz;
  v_eventos   int;
BEGIN
  SELECT id INTO v_company FROM public.companies ORDER BY created_at LIMIT 1;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'FIXTURE: nenhuma company cadastrada';
  END IF;

  -- Dono precisa estar SEM departamento nas duas fontes (company_members e
  -- users): é ele quem cobre o caso 3, o de departamento NULL.
  SELECT cm.user_id INTO v_joao
    FROM public.company_members cm
    JOIN public.users u ON u.id = cm.user_id
   WHERE cm.company_id = v_company AND cm.role = 'dono' AND cm.ativo
     AND cm.department_id IS NULL AND u.department_id IS NULL
   LIMIT 1;
  -- Mesma exigência do teste de encerrado: assumir_atendimento lê o
  -- departamento de company_members e repassar_atendimento de users, então as
  -- duas fontes precisam concordar para o esperado ser um valor só.
  SELECT cm.user_id, cm.department_id INTO v_leticia, v_dept_let
    FROM public.company_members cm
    JOIN public.users u ON u.id = cm.user_id
   WHERE cm.company_id = v_company AND cm.role = 'administrador'
     AND cm.ativo AND cm.department_id IS NOT NULL AND u.is_superadmin
     AND cm.department_id = u.department_id
   LIMIT 1;

  IF v_joao IS NULL OR v_leticia IS NULL THEN
    RAISE EXCEPTION 'FIXTURE: precisa de dono sem departamento e administrador superadmin com departamento (joao=%, adm=%)',
      v_joao, v_leticia;
  END IF;

  INSERT INTO public.clients (numero_whatsapp, nome, company_id)
  VALUES ('+5500000000001', 'TESTE atribuir/repassar em triagem', v_company)
  RETURNING id INTO v_client;

  ---------------------------------------------------------------------------
  -- Caso 1: administradora assume um atendimento no meio da triagem.
  ---------------------------------------------------------------------------
  INSERT INTO public.atendimentos
    (client_id, company_id, status, current_department_id, assigned_to,
     triagem_estagio, triagem_finished_at)
  VALUES
    (v_client, v_company, 'em_triagem', NULL, NULL,
     'aguardando_departamento', NULL)
  RETURNING id INTO v_atend;

  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_leticia)::text, true);

  v_ok := public.assumir_atendimento(v_atend);
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FALHOU [1 assumir]: esperado true, obtido %', v_ok;
  END IF;

  SELECT status, assigned_to, current_department_id, triagem_estagio, triagem_finished_at
    INTO v_status, v_assigned, v_dept, v_estagio, v_finished
    FROM public.atendimentos WHERE id = v_atend;

  IF v_status <> 'em_atendimento' THEN
    RAISE EXCEPTION 'FALHOU [1 status]: esperado em_atendimento, obtido %', v_status;
  END IF;
  IF v_assigned <> v_leticia THEN
    RAISE EXCEPTION 'FALHOU [1 assigned_to]: esperado %, obtido %', v_leticia, v_assigned;
  END IF;
  IF v_dept IS DISTINCT FROM v_dept_let THEN
    RAISE EXCEPTION 'FALHOU [1 departamento]: esperado % (do ator), obtido %', v_dept_let, v_dept;
  END IF;
  IF v_estagio <> 'concluida' OR v_finished IS NULL THEN
    RAISE EXCEPTION 'FALHOU [1 triagem]: esperado concluida/finished, obtido %/%', v_estagio, v_finished;
  END IF;

  SELECT count(*) INTO v_eventos FROM public.timeline_events
   WHERE atendimento_id = v_atend AND tipo_evento = 'atribuido'
     AND actor_user_id = v_leticia
     AND payload->>'durante_triagem' = 'true';
  IF v_eventos <> 1 THEN
    RAISE EXCEPTION 'FALHOU [1 timeline]: esperado 1 evento atribuido em triagem, obtido %', v_eventos;
  END IF;

  ---------------------------------------------------------------------------
  -- Caso 2: dono repassa um atendimento ainda em triagem para a administradora.
  ---------------------------------------------------------------------------
  UPDATE public.atendimentos
     SET status = 'em_triagem', current_department_id = NULL, assigned_to = NULL,
         assigned_at = NULL, triagem_estagio = 'aguardando_departamento',
         triagem_finished_at = NULL
   WHERE id = v_atend;

  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_joao)::text, true);

  v_ok := public.repassar_atendimento(v_atend, v_leticia, 'teste triagem');
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FALHOU [2 repassar]: esperado true, obtido %', v_ok;
  END IF;

  SELECT status, assigned_to, current_department_id, triagem_estagio, triagem_finished_at
    INTO v_status, v_assigned, v_dept, v_estagio, v_finished
    FROM public.atendimentos WHERE id = v_atend;

  IF v_status <> 'reservado' THEN
    RAISE EXCEPTION 'FALHOU [2 status]: esperado reservado, obtido %', v_status;
  END IF;
  IF v_assigned <> v_leticia THEN
    RAISE EXCEPTION 'FALHOU [2 assigned_to]: esperado %, obtido %', v_leticia, v_assigned;
  END IF;
  IF v_dept IS DISTINCT FROM v_dept_let THEN
    RAISE EXCEPTION 'FALHOU [2 departamento]: esperado % (do destino), obtido %', v_dept_let, v_dept;
  END IF;
  IF v_estagio <> 'concluida' OR v_finished IS NULL THEN
    RAISE EXCEPTION 'FALHOU [2 triagem]: esperado concluida/finished, obtido %/%', v_estagio, v_finished;
  END IF;

  SELECT count(*) INTO v_eventos FROM public.timeline_events
   WHERE atendimento_id = v_atend AND tipo_evento = 'repassado'
     AND actor_user_id = v_joao AND target_user_id = v_leticia
     AND payload->>'durante_triagem' = 'true';
  IF v_eventos <> 1 THEN
    RAISE EXCEPTION 'FALHOU [2 timeline]: esperado 1 evento repassado em triagem, obtido %', v_eventos;
  END IF;

  ---------------------------------------------------------------------------
  -- Caso 3: dono SEM departamento assume um atendimento em triagem (também sem
  -- departamento). É o caso que a CHECK atendimentos_dept_required_after_triagem_chk
  -- só aceita porque assigned_to fica preenchido — se ela regredir, estoura 23514.
  ---------------------------------------------------------------------------
  UPDATE public.atendimentos
     SET status = 'em_triagem', current_department_id = NULL, assigned_to = NULL,
         assigned_at = NULL, triagem_estagio = 'aguardando_departamento',
         triagem_finished_at = NULL
   WHERE id = v_atend;

  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_joao)::text, true);

  v_ok := public.assumir_atendimento(v_atend);
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FALHOU [3 assumir]: esperado true, obtido %', v_ok;
  END IF;

  SELECT status, assigned_to, current_department_id, triagem_estagio
    INTO v_status, v_assigned, v_dept, v_estagio
    FROM public.atendimentos WHERE id = v_atend;

  IF v_status <> 'em_atendimento' OR v_assigned <> v_joao THEN
    RAISE EXCEPTION 'FALHOU [3 status/assigned]: obtido %/%', v_status, v_assigned;
  END IF;
  IF v_dept IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU [3 departamento]: esperado NULL (ator sem setor), obtido %', v_dept;
  END IF;
  IF v_estagio <> 'concluida' THEN
    RAISE EXCEPTION 'FALHOU [3 triagem]: esperado concluida, obtido %', v_estagio;
  END IF;

  RAISE NOTICE 'OK: atribuir/repassar durante a triagem passaram nos 3 casos';
END $$;

ROLLBACK;
