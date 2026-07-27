-- Teste re-executável de atribuição/repasse em atendimento ENCERRADO sem
-- departamento (bug 23514: atendimentos_dept_required_after_triagem_chk).
--
-- Contexto: um atendimento encerrado ainda na triagem fica com
-- current_department_id = NULL. Qualquer ação que o tire de 'encerrado'
-- (Atribuir a mim / Repassar) precisa reabri-lo E resolver o departamento,
-- senão a CHECK estoura com 23514 e o usuário só vê um toast genérico.
--
-- Roda dentro de BEGIN/ROLLBACK: não deixa nada no banco (nem timeline_events,
-- que é append-only). Levanta EXCEPTION no primeiro caso que divergir.
BEGIN;

DO $$
DECLARE
  v_company   uuid;
  v_joao      uuid;  -- dono, is_superadmin, SEM departamento
  v_leticia   uuid;  -- administrador, is_superadmin, departamento "Outros"
  v_colab     uuid;  -- colaborador sem permissão de supervisão
  v_dept_let  uuid;
  v_client       uuid;
  v_atend        uuid;
  v_atend_ativo  uuid;
  v_ok        boolean;
  v_status    status_atendimento;
  v_assigned  uuid;
  v_dept      uuid;
  v_closed    timestamptz;
  v_reason    close_reason;
  v_eventos   int;
  v_errcode   text;
BEGIN
  SELECT id INTO v_company FROM public.companies ORDER BY created_at LIMIT 1;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'FIXTURE: nenhuma company cadastrada';
  END IF;

  SELECT user_id INTO v_joao FROM public.company_members
   WHERE company_id = v_company AND role = 'dono' AND ativo LIMIT 1;
  -- Exige cm.department_id = u.department_id porque assumir_atendimento lê o
  -- departamento de company_members e repassar_atendimento lê de
  -- users.department_id; com as duas fontes iguais o esperado é um só valor.
  SELECT cm.user_id, cm.department_id INTO v_leticia, v_dept_let
    FROM public.company_members cm
    JOIN public.users u ON u.id = cm.user_id
   WHERE cm.company_id = v_company AND cm.role = 'administrador'
     AND cm.ativo AND cm.department_id IS NOT NULL AND u.is_superadmin
     AND cm.department_id = u.department_id
   LIMIT 1;
  SELECT cm.user_id INTO v_colab
    FROM public.company_members cm
    JOIN public.users u ON u.id = cm.user_id
   WHERE cm.company_id = v_company AND cm.role = 'colaborador'
     AND cm.ativo AND NOT u.is_superadmin
   LIMIT 1;

  IF v_joao IS NULL OR v_leticia IS NULL OR v_colab IS NULL THEN
    RAISE EXCEPTION 'FIXTURE: precisa de dono, administrador superadmin com departamento e colaborador comum (joao=%, adm=%, colab=%)',
      v_joao, v_leticia, v_colab;
  END IF;

  -- Cliente + atendimento no estado exato do bug.
  INSERT INTO public.clients (numero_whatsapp, nome, company_id)
  VALUES ('+5500000000000', 'TESTE atribuir/repassar encerrado', v_company)
  RETURNING id INTO v_client;

  INSERT INTO public.atendimentos
    (client_id, company_id, status, current_department_id, assigned_to,
     assigned_at, closed_at, closed_by_user_id, close_reason)
  VALUES
    (v_client, v_company, 'encerrado', NULL, v_joao,
     now(), now(), v_leticia, 'manual_supervisor')
  RETURNING id INTO v_atend;

  ---------------------------------------------------------------------------
  -- Caso 1: administradora assume para si um encerrado sem departamento.
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_leticia)::text, true);

  v_ok := public.assumir_atendimento(v_atend);
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FALHOU [1 assumir]: esperado true, obtido %', v_ok;
  END IF;

  SELECT status, assigned_to, current_department_id, closed_at, close_reason
    INTO v_status, v_assigned, v_dept, v_closed, v_reason
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
  IF v_closed IS NOT NULL OR v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU [1 reabertura]: closed_at=% close_reason=% deveriam ser NULL', v_closed, v_reason;
  END IF;

  SELECT count(*) INTO v_eventos FROM public.timeline_events
   WHERE atendimento_id = v_atend AND tipo_evento = 'atribuido'
     AND actor_user_id = v_leticia AND target_user_id = v_leticia;
  IF v_eventos <> 1 THEN
    RAISE EXCEPTION 'FALHOU [1 timeline]: esperado 1 evento atribuido, obtido %', v_eventos;
  END IF;

  ---------------------------------------------------------------------------
  -- Caso 2: dono repassa um encerrado sem departamento para a administradora.
  ---------------------------------------------------------------------------
  UPDATE public.atendimentos
     SET status = 'encerrado', current_department_id = NULL, assigned_to = v_joao,
         closed_at = now(), closed_by_user_id = v_leticia, close_reason = 'manual_supervisor'
   WHERE id = v_atend;

  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_joao)::text, true);

  v_ok := public.repassar_atendimento(v_atend, v_leticia, 'teste');
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FALHOU [2 repassar]: esperado true, obtido %', v_ok;
  END IF;

  SELECT status, assigned_to, current_department_id, closed_at, close_reason
    INTO v_status, v_assigned, v_dept, v_closed, v_reason
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
  IF v_closed IS NOT NULL OR v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU [2 reabertura]: closed_at=% close_reason=% deveriam ser NULL', v_closed, v_reason;
  END IF;

  ---------------------------------------------------------------------------
  -- Caso 3: dono SEM departamento assume para si — departamento segue NULL,
  -- e isso é válido porque o atendimento tem responsável definido.
  ---------------------------------------------------------------------------
  UPDATE public.atendimentos
     SET status = 'encerrado', current_department_id = NULL, assigned_to = NULL,
         closed_at = now(), closed_by_user_id = v_leticia, close_reason = 'manual_atendente'
   WHERE id = v_atend;

  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_joao)::text, true);

  v_ok := public.assumir_atendimento(v_atend);
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FALHOU [3 assumir sem depto]: esperado true, obtido %', v_ok;
  END IF;

  SELECT status, assigned_to, current_department_id
    INTO v_status, v_assigned, v_dept
    FROM public.atendimentos WHERE id = v_atend;

  IF v_status <> 'em_atendimento' OR v_assigned <> v_joao THEN
    RAISE EXCEPTION 'FALHOU [3]: status=% assigned_to=%', v_status, v_assigned;
  END IF;
  IF v_dept IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU [3 departamento]: esperado NULL, obtido %', v_dept;
  END IF;

  ---------------------------------------------------------------------------
  -- Caso 4: colaborador comum não pode tomar para si atendimento de outro.
  ---------------------------------------------------------------------------
  UPDATE public.atendimentos
     SET status = 'em_atendimento', current_department_id = v_dept_let,
         assigned_to = v_leticia, closed_at = NULL, closed_by_user_id = NULL,
         close_reason = NULL
   WHERE id = v_atend;

  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_colab)::text, true);

  v_errcode := NULL;
  BEGIN
    PERFORM public.assumir_atendimento(v_atend);
  EXCEPTION WHEN OTHERS THEN
    v_errcode := SQLSTATE;
  END;
  IF v_errcode IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'FALHOU [4 permissão]: esperado 42501, obtido %', COALESCE(v_errcode, 'nenhum erro');
  END IF;

  ---------------------------------------------------------------------------
  -- Caso 5: reabrir um encerrado quando o cliente já tem OUTRA conversa ativa
  -- é barrado com erro claro (23505), não com o erro cru do índice
  -- uniq_atendimento_ativo_por_cliente.
  ---------------------------------------------------------------------------
  UPDATE public.atendimentos
     SET status = 'encerrado', current_department_id = NULL, assigned_to = v_joao,
         closed_at = now(), closed_by_user_id = v_leticia, close_reason = 'manual_supervisor'
   WHERE id = v_atend;

  -- Conversa nova do mesmo cliente (é o que o webhook cria quando o cliente
  -- volta a falar depois de encerrado, ou quando alguém manda mensagem pelo
  -- celular fora do sistema).
  INSERT INTO public.atendimentos
    (client_id, company_id, status, current_department_id, assigned_to, triagem_estagio, triagem_finished_at)
  VALUES
    (v_client, v_company, 'em_atendimento', v_dept_let, NULL, 'concluida', now())
  RETURNING id INTO v_atend_ativo;

  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_leticia)::text, true);
  v_errcode := NULL;
  BEGIN
    PERFORM public.assumir_atendimento(v_atend);
  EXCEPTION WHEN OTHERS THEN
    v_errcode := SQLSTATE;
  END;
  IF v_errcode IS DISTINCT FROM '23505' THEN
    RAISE EXCEPTION 'FALHOU [5 assumir com conversa ativa]: esperado 23505, obtido %', COALESCE(v_errcode, 'nenhum erro');
  END IF;

  v_errcode := NULL;
  BEGIN
    PERFORM public.repassar_atendimento(v_atend, v_leticia, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_errcode := SQLSTATE;
  END;
  IF v_errcode IS DISTINCT FROM '23505' THEN
    RAISE EXCEPTION 'FALHOU [5 repassar com conversa ativa]: esperado 23505, obtido %', COALESCE(v_errcode, 'nenhum erro');
  END IF;

  -- E a conversa ATIVA sem responsável continua atribuível normalmente.
  v_ok := public.assumir_atendimento(v_atend_ativo);
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FALHOU [5 assumir a conversa ativa]: esperado true, obtido %', v_ok;
  END IF;

  RAISE NOTICE 'assumir/repassar em encerrado: TODOS OS CASOS OK';
END $$;

ROLLBACK;
