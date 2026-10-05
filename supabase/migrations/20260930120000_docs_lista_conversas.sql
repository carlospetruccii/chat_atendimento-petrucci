-- ============================================================================
-- Aba Docs: lista de conversas sem teto para quem precisa de atenção e prévia
-- exata da última mensagem.
--
-- Problema que corrige (revisão do frontend, 30/09/2026): a tela buscava as 500
-- conversas mais recentes e filtrava/buscava em cima delas. Cada documento que o
-- outro sistema dispara "sobe" a conversa dele — num disparo em massa, um
-- cliente que respondeu e ficou SEM DONO saía da lista. É exatamente o cliente
-- no vácuo que a aba existe para mostrar. A prévia lia as 1000 mensagens mais
-- novas de um lote e podia deixar conversa com prévia vazia.
--
-- Tudo SECURITY INVOKER: a RLS das tabelas docs_* (acesso ao Docs) continua
-- valendo. Aditivo — nada existente muda.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.docs_listar_conversas(text, text, integer),
--     public.docs_ultimas_mensagens(uuid[]);
-- ============================================================================

-- Última mensagem de cada conversa: 1 busca por índice
-- (idx_docs_mensagens_conversa_created_at) por conversa, sem ler lote inteiro.
CREATE OR REPLACE FUNCTION public.docs_ultimas_mensagens(p_conversa_ids uuid[])
RETURNS TABLE (
  conversa_id uuid,
  id uuid,
  direction public.direction_mensagem,
  sender_type public.sender_type,
  tipo public.tipo_mensagem,
  content text,
  file_name text,
  created_at timestamptz,
  apagada_em timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    c.id,
    m.id,
    m.direction,
    m.sender_type,
    m.tipo,
    m.content,
    COALESCE(m.media_metadata ->> 'file_name', m.media_metadata ->> 'fileName'),
    m.created_at,
    m.apagada_em
  FROM unnest(p_conversa_ids) AS c(id)
  CROSS JOIN LATERAL (
    SELECT dm.*
    FROM public.docs_mensagens dm
    WHERE dm.conversa_id = c.id
    ORDER BY dm.created_at DESC
    LIMIT 1
  ) m;
$$;

REVOKE EXECUTE ON FUNCTION public.docs_ultimas_mensagens(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.docs_ultimas_mensagens(uuid[]) TO authenticated;

-- Lista da tela.
--   p_filtro: 'todas' | 'sem_dono' | 'em_andamento' | 'encerradas'
--   p_busca:  nome ou número (só dígitos casam com número; com letra, só nome)
--   p_limite_historico: teto só para 'so_envio'/'encerrada' — quem está
--     'sem_dono' ou 'em_andamento' SEMPRE volta, por mais antigo que seja.
CREATE OR REPLACE FUNCTION public.docs_listar_conversas(
  p_filtro text DEFAULT 'todas',
  p_busca text DEFAULT NULL,
  p_limite_historico integer DEFAULT 300
)
RETURNS TABLE (
  id uuid,
  client_id uuid,
  status public.docs_conversa_status,
  assigned_to uuid,
  assigned_at timestamptz,
  closed_at timestamptz,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  created_at timestamptz,
  cliente_nome text,
  cliente_numero text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH params AS (
    SELECT
      NULLIF(btrim(COALESCE(p_busca, '')), '') AS busca,
      NULLIF(regexp_replace(COALESCE(p_busca, ''), '\D', '', 'g'), '') AS digitos,
      COALESCE(p_busca, '') ~ '[[:alpha:]]' AS tem_letra,
      LEAST(GREATEST(COALESCE(p_limite_historico, 300), 1), 2000) AS limite
  ),
  base AS (
    SELECT c.*, cl.nome AS cliente_nome, cl.numero_whatsapp AS cliente_numero
    FROM public.docs_conversas c
    JOIN public.clients cl ON cl.id = c.client_id AND cl.company_id = c.company_id
    CROSS JOIN params p
    WHERE
      (
        p_filtro IS NULL OR p_filtro = 'todas'
        OR (p_filtro = 'sem_dono' AND c.status = 'sem_dono')
        OR (p_filtro = 'em_andamento' AND c.status = 'em_andamento')
        OR (p_filtro = 'encerradas' AND c.status = 'encerrada')
      )
      AND (
        p.busca IS NULL
        OR cl.nome ILIKE '%' || replace(replace(replace(p.busca, '\', '\\'), '%', '\%'), '_', '\_') || '%'
        OR (NOT p.tem_letra AND p.digitos IS NOT NULL
            AND regexp_replace(cl.numero_whatsapp, '\D', '', 'g') LIKE '%' || p.digitos || '%')
      )
  ),
  ativas AS (
    SELECT * FROM base WHERE status IN ('sem_dono', 'em_andamento')
  ),
  historico AS (
    SELECT * FROM base
    WHERE status IN ('so_envio', 'encerrada')
    ORDER BY last_message_at DESC NULLS LAST, created_at DESC
    LIMIT (SELECT limite FROM params)
  )
  SELECT id, client_id, status, assigned_to, assigned_at, closed_at, last_message_at,
         last_inbound_at, created_at, cliente_nome, cliente_numero
  FROM (SELECT * FROM ativas UNION ALL SELECT * FROM historico) t
  ORDER BY last_message_at DESC NULLS LAST, created_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.docs_listar_conversas(text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.docs_listar_conversas(text, text, integer) TO authenticated;
