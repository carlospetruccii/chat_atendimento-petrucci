-- ============================================================================
-- Dashboard: filtro por departamento e por pessoa
--
-- 1) atendimentos.first_response_user_id — quem mandou a PRIMEIRA mensagem de
--    atendente na conversa. É a régua do filtro "por pessoa": o tempo de
--    primeira resposta é mérito (ou culpa) de quem respondeu, não de quem está
--    com a conversa agora depois de um repasse.
--    Carimbado pelo mesmo trigger que já carimba first_response_at, e
--    independente do status: conversa iniciada pela empresa também tem dono.
--
-- 2) dashboard_relacionamento(p_from, p_to, p_department_id, p_user_id).
--    Nova assinatura SEM defaults: se tivesse default, uma chamada com só
--    (p_from, p_to) ficaria ambígua no PostgREST com a versão antiga.
--    A versão de 2 argumentos continua viva até o frontend novo subir —
--    DROP dela numa migration posterior (expand/contract).
--
--    Departamento = current_department_id (onde a conversa está).
--    Pessoa       = first_response_user_id; "sem resposta" usa assigned_to.
--    Engajamento NÃO filtra: compara o cliente com o histórico dele, e isso não
--    pertence a um departamento nem a um atendente.
-- ============================================================================

ALTER TABLE public.atendimentos
  ADD COLUMN IF NOT EXISTS first_response_user_id uuid
    REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_atendimentos_first_response_user
  ON public.atendimentos (first_response_user_id)
  WHERE first_response_user_id IS NOT NULL;

COMMENT ON COLUMN public.atendimentos.first_response_user_id IS
  'Atendente que mandou a primeira mensagem outbound de atendente. Usado no '
  'filtro por pessoa da dashboard.';

-- Backfill a partir das mensagens. Desliga só o trigger de updated_at: carimbar
-- métrica retroativa não é "alteração" da conversa e não pode mexer na ordem de
-- listas que usam updated_at.
ALTER TABLE public.atendimentos DISABLE TRIGGER trg_atendimentos_updated_at;

UPDATE public.atendimentos a
   SET first_response_user_id = p.sent_by_user_id
  FROM (
    SELECT DISTINCT ON (m.atendimento_id) m.atendimento_id, m.sent_by_user_id
      FROM public.mensagens m
     WHERE m.direction = 'outbound'
       AND m.sender_type = 'atendente'
       AND m.sent_by_user_id IS NOT NULL
     ORDER BY m.atendimento_id, m.created_at, m.id
  ) p
 WHERE p.atendimento_id = a.id
   AND a.first_response_user_id IS NULL;

ALTER TABLE public.atendimentos ENABLE TRIGGER trg_atendimentos_updated_at;

CREATE OR REPLACE FUNCTION public.promote_atendimento_em_atendimento()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.direction = 'outbound' AND NEW.sender_type = 'atendente' THEN
    UPDATE public.atendimentos
       SET status = 'em_atendimento',
           first_response_at = COALESCE(first_response_at, NEW.created_at)
     WHERE id = NEW.atendimento_id
       AND status IN ('reservado','pendente');

    -- Separado do UPDATE acima porque não depende do status. O filtro
    -- IS NULL faz dele um no-op a partir da segunda mensagem.
    IF NEW.sent_by_user_id IS NOT NULL THEN
      UPDATE public.atendimentos
         SET first_response_user_id = NEW.sent_by_user_id
       WHERE id = NEW.atendimento_id
         AND first_response_user_id IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.promote_atendimento_em_atendimento() FROM PUBLIC, anon;

-- Corpo igual ao de 20260728132824_dashboard_relacionamento.sql (os comentários
-- explicando cada bloco estão lá), mais os filtros p_department_id/p_user_id.
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
  v_engajamento jsonb;

  c_conversas_min constant integer := 3;
  c_reativo_alerta constant numeric := 90;
  c_janela_padrao constant integer := 30;
  c_janela_curta constant integer := 14;
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
      a.first_response_at,
      GREATEST(
        public.minutos_uteis_decorridos(
          a.created_at, a.first_response_at, a.current_department_id
        ),
        0
      ) AS min_uteis
    FROM public.atendimentos a
    WHERE a.company_id = v_company_id
      AND a.first_response_at IS NOT NULL
      AND a.created_at >= p_from
      AND a.created_at <= p_to
      AND (p_department_id IS NULL OR a.current_department_id = p_department_id)
      AND (p_user_id IS NULL OR a.first_response_user_id = p_user_id)
  ),
  faixas AS (
    SELECT * FROM (VALUES
      (1, '< 1m',    0,     1),
      (2, '1–5m',    1,     5),
      (3, '5–15m',   5,    15),
      (4, '15–30m',  15,   30),
      (5, '30m–1h',  30,   60),
      (6, '1–2h',    60,  120),
      (7, '2–4h',   120,  240),
      (8, '4h+',    240, 2147483647)
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
         AND a.first_response_at IS NULL
         AND a.created_at >= p_from
         AND a.created_at <= p_to
         AND (p_department_id IS NULL OR a.current_department_id = p_department_id)
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
      AND (p_department_id IS NULL OR a.current_department_id = p_department_id)
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
      AND (p_department_id IS NULL OR a.current_department_id = p_department_id)
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
  ),
  por_cliente AS (
    SELECT
      conv.client_id,
      count(*) AS conversas,
      count(*) FILTER (WHERE p.direction = 'inbound') AS iniciadas_cliente
    FROM primeira p
    JOIN conv ON conv.id = p.atendimento_id
    GROUP BY conv.client_id
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
    ),
    'contas_reativas', COALESCE((
      SELECT jsonb_agg(x ORDER BY (x->>'conversas')::int DESC, x->>'cliente')
      FROM (
        SELECT jsonb_build_object(
          'client_id', pc.client_id,
          'cliente', COALESCE(NULLIF(btrim(cl.nome), ''), cl.numero_whatsapp),
          'conversas', pc.conversas,
          'pct_cliente', round(100.0 * pc.iniciadas_cliente / pc.conversas)
        ) AS x
        FROM por_cliente pc
        LEFT JOIN public.clients cl ON cl.id = pc.client_id
        WHERE pc.conversas >= c_conversas_min
          AND round(100.0 * pc.iniciadas_cliente / pc.conversas) >= c_reativo_alerta
        ORDER BY pc.conversas DESC
        LIMIT 6
      ) s
    ), '[]'::jsonb)
  ) INTO v_iniciativa;

  v_engajamento := public.dashboard_engajamento(v_company_id, p_to, c_janela_padrao);

  IF COALESCE((v_engajamento->>'clientes_avaliados')::int, 0) = 0 THEN
    v_engajamento := public.dashboard_engajamento(v_company_id, p_to, c_janela_curta)
                     || jsonb_build_object('janela_reduzida', true);
  END IF;

  RETURN jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'primeira_resposta', v_primeira_resposta,
    'transferencias', v_transferencias,
    'iniciativa', v_iniciativa,
    'engajamento', v_engajamento
  );
END;
$$;

COMMENT ON FUNCTION public.dashboard_relacionamento(timestamptz, timestamptz, uuid, uuid) IS
  'Métricas de relacionamento da dashboard com filtro opcional (NULL = todos) '
  'por departamento atual e por atendente da primeira resposta. Engajamento '
  'ignora os filtros.';

REVOKE ALL ON FUNCTION public.dashboard_relacionamento(timestamptz, timestamptz, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_relacionamento(timestamptz, timestamptz, uuid, uuid) TO authenticated, service_role;
