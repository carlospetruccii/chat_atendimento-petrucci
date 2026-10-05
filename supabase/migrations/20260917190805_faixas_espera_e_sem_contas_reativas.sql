-- ============================================================================
-- Primeira resposta em faixas mais finas, e adeus "contas em que só o cliente
-- puxa"
--
-- 1) O histograma de espera tinha faixas largas demais pra operação real:
--    quase tudo caía em "< 1m" e "1–5m" e o card virava "100% em até 1h", que
--    não ajuda ninguém a agir. Agora são 7 faixas: até 5min, 5–10, 10–15,
--    15–30, 30min–1h, 1h–1h30 e +1h30.
-- 2) A lista de contas reativas saiu da dashboard (pedido de 17/09/2026), e
--    com ela a agregação por cliente do bloco de iniciativa.
--
-- Corpo igual ao de 20260917182955 fora esses dois pontos.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.dashboard_relacionamento(
  p_from timestamptz,
  p_to timestamptz,
  p_department_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
  v_primeira_resposta jsonb;
  v_transferencias jsonb;
  v_iniciativa jsonb;

  -- Sentinela de "Sem departamento" no filtro: uuid zerado. Evita mais um
  -- parâmetro na assinatura só pra dizer "departamento IS NULL".
  c_sem_departamento constant uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  v_company_id := public.dashboard_company_do_chamador();

  IF v_company_id IS NULL OR NOT public.is_member_of(v_company_id) THEN
    RAISE EXCEPTION 'Sem empresa vinculada para o dashboard'
      USING ERRCODE = '42501';
  END IF;

  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'Período inválido' USING ERRCODE = '22023';
  END IF;

  WITH resp AS MATERIALIZED (
    SELECT
      a.id,
      a.client_id,
      a.created_at,
      a.primeira_resposta_at,
      GREATEST(
        public.minutos_uteis_decorridos(
          a.created_at, a.primeira_resposta_at, a.current_department_id
        ),
        0
      ) AS min_uteis
    FROM public.atendimentos a
    WHERE a.company_id = v_company_id
      -- Só conversa que o cliente puxou: em conversa que a empresa começou
      -- não há ninguém esperando resposta.
      AND a.iniciada_pelo_cliente
      AND a.primeira_resposta_at IS NOT NULL
      AND a.created_at >= p_from
      AND a.created_at <= p_to
      AND (p_department_id IS NULL
           OR (p_department_id = c_sem_departamento AND a.current_department_id IS NULL)
           OR a.current_department_id = p_department_id)
      AND (p_user_id IS NULL OR a.first_response_user_id = p_user_id)
  ),
  faixas AS (
    SELECT * FROM (VALUES
      (1, 'até 5min',   0,          5),
      (2, '5–10min',    5,         10),
      (3, '10–15min',  10,         15),
      (4, '15–30min',  15,         30),
      (5, '30min–1h',  30,         60),
      (6, '1h–1h30',   60,         90),
      (7, '+1h30',     90, 2147483647)
    ) AS f(ord, rotulo, min_inc, max_exc)
  ),
  histograma AS (
    SELECT
      f.ord,
      f.rotulo,
      count(r.id) AS total
    FROM faixas f
    LEFT JOIN resp r
      ON r.min_uteis >= f.min_inc
     AND (f.max_exc = 2147483647 OR r.min_uteis < f.max_exc)
    GROUP BY f.ord, f.rotulo
  ),
  pior AS (
    SELECT
      r.id,
      r.min_uteis,
      r.created_at,
      COALESCE(NULLIF(btrim(c.nome), ''), c.numero_whatsapp) AS cliente
    FROM resp r
    LEFT JOIN public.clients c ON c.id = r.client_id
    ORDER BY r.min_uteis DESC, r.created_at DESC
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM resp),
    'sem_resposta', (
      SELECT count(*) FROM public.atendimentos a
       WHERE a.company_id = v_company_id
         AND a.iniciada_pelo_cliente
         AND a.primeira_resposta_at IS NULL
         AND a.created_at >= p_from
         AND a.created_at <= p_to
         AND (p_department_id IS NULL
              OR (p_department_id = c_sem_departamento AND a.current_department_id IS NULL)
              OR a.current_department_id = p_department_id)
         AND (p_user_id IS NULL OR a.assigned_to = p_user_id)
    ),
    'media_min', (SELECT round(avg(min_uteis)) FROM resp),
    'p50_min', (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY min_uteis)) FROM resp),
    'p95_min', (SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY min_uteis)) FROM resp),
    'max_min', (SELECT max(min_uteis) FROM resp),
    'pior', (
      SELECT jsonb_build_object(
        'atendimento_id', p.id,
        'cliente', p.cliente,
        'min', p.min_uteis,
        'quando', p.created_at
      ) FROM pior p
    ),
    'histograma', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('faixa', h.rotulo, 'total', h.total) ORDER BY h.ord)
      FROM histograma h
    ), '[]'::jsonb)
  ) INTO v_primeira_resposta;

  WITH conv AS (
    SELECT a.id, a.client_id
    FROM public.atendimentos a
    WHERE a.company_id = v_company_id
      AND a.created_at >= p_from
      AND a.created_at <= p_to
      AND (p_department_id IS NULL
           OR (p_department_id = c_sem_departamento AND a.current_department_id IS NULL)
           OR a.current_department_id = p_department_id)
      AND (p_user_id IS NULL OR a.first_response_user_id = p_user_id)
  ),
  saltos AS (
    SELECT
      te.atendimento_id,
      te.created_at,
      dfrom.nome AS de,
      dto.nome AS para
    FROM public.timeline_events te
    JOIN conv ON conv.id = te.atendimento_id
    JOIN public.departments dfrom ON dfrom.id = te.from_department_id
    JOIN public.departments dto ON dto.id = te.to_department_id
    WHERE te.tipo_evento IN ('repassado', 'escalado')
      AND te.from_department_id <> te.to_department_id
  ),
  por_conversa AS (
    SELECT
      s.atendimento_id,
      count(*) AS saltos,
      (array_agg(s.de ORDER BY s.created_at))[1] AS origem,
      array_agg(s.para ORDER BY s.created_at) AS destinos,
      max(s.created_at) AS ultimo_salto
    FROM saltos s
    GROUP BY s.atendimento_id
  ),
  conv_saltos AS (
    SELECT c.id, COALESCE(pc.saltos, 0) AS saltos
    FROM conv c
    LEFT JOIN por_conversa pc ON pc.atendimento_id = c.id
  ),
  distribuicao AS (
    SELECT * FROM (VALUES (1, '0'), (2, '1'), (3, '2'), (4, '3+')) AS d(ord, rotulo)
  ),
  dist_valores AS (
    SELECT
      d.ord,
      d.rotulo,
      count(cs.id) AS total
    FROM distribuicao d
    LEFT JOIN conv_saltos cs
      ON (CASE WHEN cs.saltos >= 3 THEN '3+' ELSE cs.saltos::text END) = d.rotulo
    GROUP BY d.ord, d.rotulo
  )
  SELECT jsonb_build_object(
    'conversas', (SELECT count(*) FROM conv),
    'com_transferencia', (SELECT count(*) FROM por_conversa),
    'duas_ou_mais', (SELECT count(*) FROM por_conversa WHERE saltos >= 2),
    'total_saltos', COALESCE((SELECT sum(saltos) FROM por_conversa), 0),
    'distribuicao', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('faixa', dv.rotulo, 'total', dv.total) ORDER BY dv.ord)
      FROM dist_valores dv
    ), '[]'::jsonb),
    'peregrinacoes', COALESCE((
      SELECT jsonb_agg(p ORDER BY (p->>'saltos')::int DESC, p->>'quando' DESC)
      FROM (
        SELECT jsonb_build_object(
          'atendimento_id', pc.atendimento_id,
          'cliente', COALESCE(NULLIF(btrim(cl.nome), ''), cl.numero_whatsapp),
          'saltos', pc.saltos,
          'caminho', array_prepend(pc.origem, pc.destinos),
          'quando', pc.ultimo_salto
        ) AS p
        FROM por_conversa pc
        JOIN conv ON conv.id = pc.atendimento_id
        LEFT JOIN public.clients cl ON cl.id = conv.client_id
        WHERE pc.saltos >= 2
        ORDER BY pc.saltos DESC, pc.ultimo_salto DESC
        LIMIT 6
      ) s
    ), '[]'::jsonb)
  ) INTO v_transferencias;

  WITH conv AS (
    SELECT a.id, a.client_id
    FROM public.atendimentos a
    WHERE a.company_id = v_company_id
      AND a.created_at >= p_from
      AND a.created_at <= p_to
      AND (p_department_id IS NULL
           OR (p_department_id = c_sem_departamento AND a.current_department_id IS NULL)
           OR a.current_department_id = p_department_id)
      AND (p_user_id IS NULL OR a.first_response_user_id = p_user_id)
  ),
  primeira AS (
    SELECT DISTINCT ON (m.atendimento_id)
      m.atendimento_id,
      m.direction,
      m.sender_type
    FROM public.mensagens m
    JOIN conv ON conv.id = m.atendimento_id
    ORDER BY m.atendimento_id, m.created_at ASC, m.id ASC
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM primeira),
    'sem_mensagem', (SELECT count(*) FROM conv WHERE id NOT IN (SELECT atendimento_id FROM primeira)),
    'cliente', (SELECT count(*) FROM primeira WHERE direction = 'inbound'),
    'empresa', (SELECT count(*) FROM primeira WHERE direction = 'outbound'),
    'empresa_pelo_sistema', (
      SELECT count(*) FROM primeira
       WHERE direction = 'outbound' AND sender_type <> 'externo'
    ),
    'empresa_fora_do_sistema', (
      SELECT count(*) FROM primeira
       WHERE direction = 'outbound' AND sender_type = 'externo'
    )
  ) INTO v_iniciativa;

  RETURN jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'primeira_resposta', v_primeira_resposta,
    'transferencias', v_transferencias,
    'iniciativa', v_iniciativa
  );
END;
$$;

COMMENT ON FUNCTION public.dashboard_relacionamento(timestamptz, timestamptz, uuid, uuid) IS
  'Métricas de relacionamento da dashboard. Primeira resposta = primeira '
  'mensagem humana de saída, só em conversa puxada pelo cliente, em 7 faixas '
  'de espera. Filtros: NULL = todos; uuid zerado em p_department_id = sem '
  'departamento.';
