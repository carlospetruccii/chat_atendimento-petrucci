-- ============================================================================
-- Aba Docs: a busca da lista também acha pelo nome do contato do Google.
--
-- A lista mostra o nome do Google (tabela `contatos`) quando existe, mas
-- docs_listar_conversas só comparava com clients.nome — buscar pelo nome que
-- aparecia na tela dava "nenhuma conversa". Mesma assinatura: CREATE OR REPLACE.
-- ============================================================================

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
      '%' || replace(replace(replace(btrim(COALESCE(p_busca, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS padrao,
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
        OR cl.nome ILIKE p.padrao
        -- A lista mostra o nome do contato do Google quando existe: a busca
        -- tem que achar por ele também.
        OR EXISTS (
          SELECT 1 FROM public.contatos ct
          WHERE ct.company_id = c.company_id
            AND ct.numero_whatsapp = cl.numero_whatsapp
            AND ct.nome ILIKE p.padrao
        )
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

