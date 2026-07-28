-- ============================================================================
-- Dashboard de Relacionamento — métricas de "Camada 1" (só metadados)
--
-- Quatro sinais que não precisam de IA nem de leitura de conteúdo. Todos saem
-- de colunas que já existem; o valor está em COMO agregar:
--
--   1) Primeira resposta — em minutos ÚTEIS (respeita expediente do
--      departamento e feriados) e olhando a CAUDA (p95 + pior episódio
--      nomeado), não a média. A média esconde exatamente o episódio que gerou
--      a insatisfação.
--   2) Transferências entre departamentos por conversa. Cliente que passa por
--      fiscal → contábil → financeiro pra resolver uma coisa teve experiência
--      ruim, e isso é puro metadado.
--   3) Quem inicia a conversa. Se quase toda conversa de um cliente começa com
--      ele, a operação é 100% reativa naquela conta.
--   4) Volume de mensagens do cliente comparado ao HISTÓRICO DELE (janela vs
--      janela anterior), não à média geral. A queda é o sinal: quem caiu de 40
--      msgs/mês pra 4 não ficou satisfeito, ficou desengajado.
--
-- Tudo em um único RPC pra evitar N round-trips do browser e pra manter o
-- cálculo de minutos úteis no servidor (minutos_uteis_decorridos é SECURITY
-- DEFINER e revogada de `authenticated`, então só roda de dentro daqui).
--
-- LIMITE CONHECIDO: minutos_uteis_decorridos tem teto interno de 30 dias de
-- lookback (`v_start := GREATEST(v_start, v_end - INTERVAL '30 days')`, migration
-- 20260720160000). Um atendimento cuja primeira resposta demorasse MAIS de 30
-- dias de relógio teria o tempo útil subestimado. Medido em 28/07/2026: zero
-- casos. Se algum dia aparecer, o teto é lá que muda — não aqui.
--
-- CUSTO: ~60µs por chamada de minutos_uteis_decorridos (loop dia-a-dia), uma por
-- atendimento respondido no período. RPC completo em 31,7ms com 102 respondidos.
-- Escala linear: se passar de alguns milhares de atendimentos por período, a
-- saída é materializar o minuto útil numa coluna no momento da resposta, em vez
-- de recalcular a cada leitura da dashboard.
-- ============================================================================

-- Índices de apoio. As agregações varrem mensagens por (company_id, direction,
-- created_at) e por (atendimento_id, created_at); sem eles a janela dupla vira
-- seq scan à medida que a tabela cresce.
CREATE INDEX IF NOT EXISTS idx_mensagens_company_direction_created
  ON public.mensagens (company_id, direction, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mensagens_atendimento_created
  ON public.mensagens (atendimento_id, created_at);

CREATE INDEX IF NOT EXISTS idx_atendimentos_company_created
  ON public.atendimentos (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_timeline_events_tipo_atendimento
  ON public.timeline_events (tipo_evento, atendimento_id);

-- ----------------------------------------------------------------------------
-- Resolve a empresa do chamador. Em instalação single-tenant com o
-- interruptor auth_enforcement_enabled = 'false' os usuários podem não ter
-- vínculo em company_members ainda; nesse modo cai pra empresa única. Com o
-- enforcement ligado, sem vínculo = sem dado.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dashboard_company_do_chamador()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
  v_total_companies integer;
BEGIN
  SELECT m.company_id INTO v_company_id
    FROM public.company_members m
   WHERE m.user_id = auth.uid() AND m.ativo = true
   ORDER BY m.created_at
   LIMIT 1;

  IF v_company_id IS NOT NULL THEN
    RETURN v_company_id;
  END IF;

  IF public.auth_enforcement_enabled() THEN
    RETURN NULL;
  END IF;

  -- Ponte do modo aberto: só resolve automaticamente se houver UMA empresa.
  -- Com mais de uma, devolver "a primeira" seria vazar dado da empresa errada.
  SELECT count(*) INTO v_total_companies FROM public.companies;
  IF v_total_companies <> 1 THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_company_id FROM public.companies LIMIT 1;
  RETURN v_company_id;
END;
$$;

-- SECURITY: uso interno. Não precisa ser exposta no /rest/v1/rpc — quem a
-- chama é dashboard_relacionamento, que roda como DEFINER e portanto usa os
-- privilégios do dono, não os do chamador. Deixar `authenticated` com EXECUTE
-- aqui só criaria um endpoint SECURITY DEFINER a mais sem nenhum ganho.
REVOKE ALL ON FUNCTION public.dashboard_company_do_chamador()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_company_do_chamador() TO service_role;

-- ----------------------------------------------------------------------------
-- ENGAJAMENTO — volume do cliente contra o histórico DELE.
--
-- Unidade separada porque é a única métrica com régua ajustável: compara a
-- janela [p_to - N, p_to] com a janela anterior de mesmo tamanho. Isolar aqui
-- permite chamá-la com N diferente sem duplicar a agregação.
--
-- Conta só mensagens 'inbound': o sinal é o CLIENTE falando menos, não a gente
-- mandando menos.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dashboard_engajamento(
  p_company_id uuid,
  p_to timestamptz,
  p_janela_dias integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_janela interval;
  -- Baseline mínimo pra um cliente entrar no cálculo. Abaixo disso o percentual
  -- é ruído: cair de 2 msgs pra 1 não é desengajamento.
  c_baseline_min constant integer := 5;
  -- Queda a partir da qual o cliente acende alerta.
  c_queda_alerta constant numeric := -50;
BEGIN
  IF p_company_id IS NULL OR p_to IS NULL OR p_janela_dias IS NULL OR p_janela_dias < 1 THEN
    RAISE EXCEPTION 'Parâmetros inválidos para dashboard_engajamento'
      USING ERRCODE = '22023';
  END IF;

  v_janela := make_interval(days => p_janela_dias);

  WITH atual AS (
    SELECT m.client_id, count(*) AS n
    FROM public.mensagens m
    WHERE m.company_id = p_company_id
      AND m.direction = 'inbound'
      AND m.created_at > p_to - v_janela
      AND m.created_at <= p_to
    GROUP BY m.client_id
  ),
  anterior AS (
    SELECT m.client_id, count(*) AS n
    FROM public.mensagens m
    WHERE m.company_id = p_company_id
      AND m.direction = 'inbound'
      AND m.created_at > p_to - (v_janela * 2)
      AND m.created_at <= p_to - v_janela
    GROUP BY m.client_id
  ),
  ultimo_contato AS (
    SELECT m.client_id, max(m.created_at) AS quando
    FROM public.mensagens m
    WHERE m.company_id = p_company_id
      AND m.direction = 'inbound'
    GROUP BY m.client_id
  ),
  comparado AS (
    SELECT
      ant.client_id,
      COALESCE(ag.n, 0) AS agora,
      ant.n AS antes,
      round(100.0 * (COALESCE(ag.n, 0) - ant.n) / ant.n) AS delta_pct,
      GREATEST(EXTRACT(DAY FROM (p_to - uc.quando))::int, 0) AS dias_sem_contato
    FROM anterior ant
    LEFT JOIN atual ag ON ag.client_id = ant.client_id
    LEFT JOIN ultimo_contato uc ON uc.client_id = ant.client_id
    WHERE ant.n >= c_baseline_min
  )
  SELECT jsonb_build_object(
    'janela_dias', p_janela_dias,
    'janela_reduzida', false,
    'baseline_min', c_baseline_min,
    'limite_queda_pct', c_queda_alerta,
    'clientes_avaliados', (SELECT count(*) FROM comparado),
    'em_queda', (SELECT count(*) FROM comparado WHERE delta_pct <= c_queda_alerta),
    'msgs_agora', COALESCE((SELECT sum(agora) FROM comparado), 0),
    'msgs_antes', COALESCE((SELECT sum(antes) FROM comparado), 0),
    'quedas', COALESCE((
      SELECT jsonb_agg(x ORDER BY (x->>'delta_pct')::numeric ASC, (x->>'antes')::int DESC)
      FROM (
        SELECT jsonb_build_object(
          'client_id', c.client_id,
          'cliente', COALESCE(NULLIF(btrim(cl.nome), ''), cl.numero_whatsapp),
          'agora', c.agora,
          'antes', c.antes,
          'delta_pct', c.delta_pct,
          'dias_sem_contato', c.dias_sem_contato
        ) AS x
        FROM comparado c
        LEFT JOIN public.clients cl ON cl.id = c.client_id
        WHERE c.delta_pct <= c_queda_alerta
        ORDER BY c.delta_pct ASC, c.antes DESC
        LIMIT 6
      ) s
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- SECURITY (CRÍTICO): recebe p_company_id por PARÂMETRO e é SECURITY DEFINER,
-- então bypassa RLS. Só pode ser chamada de dentro de dashboard_relacionamento,
-- que resolve a empresa de auth.uid(). Se `authenticated` tivesse EXECUTE aqui,
-- qualquer usuário logado poderia passar o company_id de outra empresa e ler
-- nome/telefone dos clientes dela (LGPD).
REVOKE ALL ON FUNCTION public.dashboard_engajamento(uuid, timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_engajamento(uuid, timestamptz, integer)
  TO service_role;

-- ----------------------------------------------------------------------------
-- RPC principal.
--
-- p_from/p_to filtram os blocos 1–3 (primeira resposta, transferências,
-- iniciativa). O bloco 4 (engajamento) IGNORA o filtro de propósito: comparar
-- "hoje vs ontem" não diz nada sobre desengajamento. Ele usa janelas fixas
-- ancoradas em p_to.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dashboard_relacionamento(
  p_from timestamptz,
  p_to timestamptz
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

  -- Mínimo de conversas pra classificar uma conta como reativa.
  c_conversas_min constant integer := 3;
  -- A partir de quantos % das conversas iniciadas pelo cliente a conta é
  -- considerada "puramente reativa".
  c_reativo_alerta constant numeric := 90;
  -- Régua padrão do engajamento, e a régua curta de fallback.
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

  -- ==========================================================================
  -- 1) PRIMEIRA RESPOSTA — cauda, não média
  -- ==========================================================================
  -- MATERIALIZED explícito: `resp` é lida por 6 agregações diferentes e cada
  -- linha custa um loop dia-a-dia dentro de minutos_uteis_decorridos. Sem isso
  -- o planner poderia inline-ar a CTE e recalcular a função a cada referência.
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
  ),
  faixas AS (
    -- Ordem fixa das faixas do histograma. Fica no SQL pra o front não ter que
    -- reordenar nem inventar faixa vazia.
    --
    -- O primeiro balde é "< 1m" e não "≤ 5m" de propósito: na operação real a
    -- maioria das respostas sai no mesmo minuto, e um balde 0–5m engoliria ~70%
    -- da amostra num bloco só, escondendo a forma da curva.
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

  -- ==========================================================================
  -- 2) TRANSFERÊNCIAS ENTRE DEPARTAMENTOS
  --
  -- Só conta salto que TROCA de departamento. Repasse dentro do mesmo
  -- departamento (colega A → colega B) é rotina, não peregrinação. Também
  -- ignora 'triagem_concluida', que apenas define o primeiro departamento.
  -- ==========================================================================
  WITH conv AS (
    SELECT a.id, a.client_id
    FROM public.atendimentos a
    WHERE a.company_id = v_company_id
      AND a.created_at >= p_from
      AND a.created_at <= p_to
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
    -- As piores jornadas, com o caminho completo pra mostrar como chip.
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

  -- ==========================================================================
  -- 3) QUEM INICIA A CONVERSA
  --
  -- Usa a DIREÇÃO da primeira mensagem, não sender_type: 'inbound' é sempre o
  -- cliente, e 'outbound' cobre atendente, bot, sistema e externo sem depender
  -- de qual deles disparou. Conversa iniciada pela empresa = contato proativo.
  -- ==========================================================================
  WITH conv AS (
    SELECT a.id, a.client_id
    FROM public.atendimentos a
    WHERE a.company_id = v_company_id
      AND a.created_at >= p_from
      AND a.created_at <= p_to
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
    -- Quebra do contato proativo. sender_type='externo' é alguém do time
    -- respondendo pelo celular, com o número da empresa, sem passar pela
    -- plataforma (RN-20). Continua sendo proativo — é humano e é a empresa
    -- puxando —, mas precisa aparecer separado: senão o card sugere um uso do
    -- sistema que não está acontecendo.
    'empresa_pelo_sistema', (
      SELECT count(*) FROM primeira
       WHERE direction = 'outbound' AND sender_type <> 'externo'
    ),
    'empresa_fora_do_sistema', (
      SELECT count(*) FROM primeira
       WHERE direction = 'outbound' AND sender_type = 'externo'
    ),
    -- Contas em que a operação é puramente reativa: o cliente sempre puxa.
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

  -- ==========================================================================
  -- 4) ENGAJAMENTO — delegado, com régua adaptativa
  --
  -- 30 dias é a régua certa. Mas numa base recém-implantada a janela anterior
  -- ainda está vazia e o bloco sairia sem nenhum cliente avaliado — um card
  -- morto onde deveria estar o sinal mais importante. Nesse caso encurta pra
  -- 14 dias e marca janela_reduzida = true, pro front dizer qual régua usou.
  -- Não inventa dado: só encurta a régua e admite que encurtou.
  -- ==========================================================================
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

COMMENT ON FUNCTION public.dashboard_relacionamento(timestamptz, timestamptz) IS
  'Métricas de relacionamento da dashboard (Camada 1, só metadados): primeira '
  'resposta em minutos úteis com foco na cauda, transferências entre '
  'departamentos, iniciativa proativo/reativo e queda de engajamento por '
  'cliente (janela vs janela anterior, independente do filtro de período).';

COMMENT ON FUNCTION public.dashboard_engajamento(uuid, timestamptz, integer) IS
  'Compara o volume de mensagens inbound de cada cliente entre [p_to - N, p_to] '
  'e a janela anterior de mesmo tamanho. Uso interno: recebe company_id por '
  'parâmetro e bypassa RLS, então só service_role tem EXECUTE.';

-- SECURITY: devolve nome/telefone de clientes (PII). `anon` nunca pode chamar.
-- `authenticated` pode, porque o escopo da empresa é resolvido de auth.uid()
-- dentro da função — nunca de parâmetro — e validado com is_member_of.
REVOKE ALL ON FUNCTION public.dashboard_relacionamento(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_relacionamento(timestamptz, timestamptz) TO authenticated, service_role;
