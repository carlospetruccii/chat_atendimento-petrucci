-- Teste re-executável da métrica de primeira resposta corrigida
-- (migration 20260917182955_primeira_resposta_real).
--
-- Cobre os três desvios que a auditoria de 17/09/2026 achou, mais o filtro
-- "Sem departamento":
--   1) conversa já em 'em_atendimento' respondida pelo atendente CONTA
--      (antes o trigger não carimbava e ela virava "sem resposta");
--   2) conversa que a EMPRESA puxou não entra em lugar nenhum da espera;
--   3) resposta pelo celular (sender_type 'externo') conta como resposta;
--   4) cliente sem resposta entra em sem_resposta;
--   5) sentinela de uuid zerado filtra quem está sem departamento.
--
-- Fixtures em 2099. Roda dentro de BEGIN/ROLLBACK e levanta EXCEPTION no
-- primeiro caso divergente.
BEGIN;

DO $$
DECLARE
  v_company uuid;
  v_user    uuid;
  v_dept    uuid;
  v_cli     uuid[] := ARRAY[]::uuid[];
  v_at      uuid[] := ARRAY[]::uuid[];
  v_tmp     uuid;
  v_r       jsonb;
  v_bool    boolean;
  c_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  c_from constant timestamptz := '2099-02-05 00:00:00-03';
  c_to   constant timestamptz := '2099-02-05 23:59:59-03';
  i int;
BEGIN
  SELECT id INTO v_company FROM public.companies ORDER BY created_at LIMIT 1;
  SELECT cm.user_id INTO v_user FROM public.company_members cm
   WHERE cm.company_id = v_company AND cm.ativo ORDER BY cm.created_at LIMIT 1;
  SELECT id INTO v_dept FROM public.departments WHERE ativo ORDER BY nome LIMIT 1;

  IF v_company IS NULL OR v_user IS NULL OR v_dept IS NULL THEN
    RAISE EXCEPTION 'FIXTURE: precisa de empresa, membro ativo e departamento ativo';
  END IF;

  SET LOCAL ROLE service_role;

  FOR i IN 1..5 LOOP
    INSERT INTO public.clients (numero_whatsapp, nome, company_id)
    VALUES ('+55980000000' || i, 'TESTE primeira resposta ' || i, v_company)
    RETURNING id INTO v_tmp;
    v_cli := v_cli || v_tmp;
  END LOOP;

  -- 1: cliente puxou, já em atendimento, atendente respondeu 30min depois
  -- 2: empresa puxou (outbound primeiro)
  -- 3: cliente puxou, resposta veio pelo celular (externo) 10min depois
  -- 4: cliente puxou, ninguém respondeu
  -- 5: cliente puxou, SEM departamento, respondida em 5min
  FOR i IN 1..5 LOOP
    INSERT INTO public.atendimentos
      (client_id, company_id, status, current_department_id, assigned_to, created_at)
    VALUES (v_cli[i], v_company, 'em_atendimento',
            CASE WHEN i = 5 THEN NULL ELSE v_dept END, v_user, '2099-02-05 10:00-03')
    RETURNING id INTO v_tmp;
    v_at := v_at || v_tmp;
  END LOOP;

  INSERT INTO public.mensagens
    (atendimento_id, client_id, company_id, department_id, direction, sender_type, sent_by_user_id, tipo, content, created_at)
  VALUES
    (v_at[1], v_cli[1], v_company, v_dept, 'inbound',  'cliente',   NULL,   'texto', 'oi',   '2099-02-05 10:00-03'),
    (v_at[1], v_cli[1], v_company, v_dept, 'outbound', 'atendente', v_user, 'texto', 'oi!',  '2099-02-05 10:30-03'),
    (v_at[2], v_cli[2], v_company, v_dept, 'outbound', 'atendente', v_user, 'texto', 'olá',  '2099-02-05 10:00-03'),
    (v_at[2], v_cli[2], v_company, v_dept, 'inbound',  'cliente',   NULL,   'texto', 'oi',   '2099-02-05 10:40-03'),
    (v_at[3], v_cli[3], v_company, v_dept, 'inbound',  'cliente',   NULL,   'texto', 'oi',   '2099-02-05 10:00-03'),
    (v_at[3], v_cli[3], v_company, v_dept, 'outbound', 'externo',   NULL,   'texto', 'aqui', '2099-02-05 10:10-03'),
    (v_at[4], v_cli[4], v_company, v_dept, 'inbound',  'cliente',   NULL,   'texto', 'oi',   '2099-02-05 10:00-03'),
    (v_at[5], v_cli[5], v_company, NULL,   'inbound',  'cliente',   NULL,   'texto', 'oi',   '2099-02-05 10:00-03'),
    (v_at[5], v_cli[5], v_company, NULL,   'outbound', 'atendente', v_user, 'texto', 'oi!',  '2099-02-05 10:05-03');

  RESET ROLE;

  ---------------------------------------------------------------------------
  -- Colunas carimbadas pelo trigger
  ---------------------------------------------------------------------------
  SELECT iniciada_pelo_cliente INTO v_bool FROM public.atendimentos WHERE id = v_at[2];
  IF v_bool IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'TRIGGER: conversa puxada pela empresa deveria ser false, veio %', v_bool;
  END IF;

  SELECT primeira_resposta_at IS NOT NULL INTO v_bool FROM public.atendimentos WHERE id = v_at[3];
  IF NOT v_bool THEN
    RAISE EXCEPTION 'TRIGGER: resposta por externo não carimbou primeira_resposta_at';
  END IF;

  SELECT primeira_resposta_at IS NULL INTO v_bool FROM public.atendimentos WHERE id = v_at[4];
  IF NOT v_bool THEN
    RAISE EXCEPTION 'TRIGGER: conversa sem resposta não pode ter primeira_resposta_at';
  END IF;

  -- first_response_at legado continua nulo aqui (status era em_atendimento):
  -- é exatamente o buraco que a coluna nova tapa.
  SELECT first_response_at IS NULL INTO v_bool FROM public.atendimentos WHERE id = v_at[1];
  IF NOT v_bool THEN
    RAISE EXCEPTION 'FIXTURE: cenário do bug mudou — first_response_at foi carimbado';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);

  ---------------------------------------------------------------------------
  -- Sem filtro: respondidos = 1, 3 e 5; sem resposta = 4; a 2 fica fora.
  ---------------------------------------------------------------------------
  v_r := public.dashboard_relacionamento(c_from, c_to, NULL, NULL)->'primeira_resposta';
  IF (v_r->>'total')::int <> 3 OR (v_r->>'sem_resposta')::int <> 1 THEN
    RAISE EXCEPTION 'CASO 1 (sem filtro): %', v_r;
  END IF;
  -- 30min + 10min + 5min = 45/3 = 15
  IF (v_r->>'media_min')::int <> 15 OR (v_r->>'max_min')::int <> 30 THEN
    RAISE EXCEPTION 'CASO 1 (tempos): %', v_r;
  END IF;

  ---------------------------------------------------------------------------
  -- Filtro do departamento: perde a 5 (que está sem departamento).
  ---------------------------------------------------------------------------
  v_r := public.dashboard_relacionamento(c_from, c_to, v_dept, NULL)->'primeira_resposta';
  IF (v_r->>'total')::int <> 2 OR (v_r->>'sem_resposta')::int <> 1 THEN
    RAISE EXCEPTION 'CASO 2 (departamento): %', v_r;
  END IF;

  ---------------------------------------------------------------------------
  -- Sentinela "Sem departamento": só a 5.
  ---------------------------------------------------------------------------
  v_r := public.dashboard_relacionamento(c_from, c_to, c_zero, NULL)->'primeira_resposta';
  IF (v_r->>'total')::int <> 1 OR (v_r->>'media_min')::int <> 5 THEN
    RAISE EXCEPTION 'CASO 3 (sem departamento): %', v_r;
  END IF;

  ---------------------------------------------------------------------------
  -- Filtro por pessoa: só quem respondeu pelo sistema (1 e 5). A resposta por
  -- celular não tem dono, então a 3 fica de fora.
  ---------------------------------------------------------------------------
  v_r := public.dashboard_relacionamento(c_from, c_to, NULL, v_user)->'primeira_resposta';
  IF (v_r->>'total')::int <> 2 THEN
    RAISE EXCEPTION 'CASO 4 (pessoa): %', v_r;
  END IF;

  RAISE NOTICE 'primeira_resposta_real: todos os casos OK';
END;
$$;

ROLLBACK;
