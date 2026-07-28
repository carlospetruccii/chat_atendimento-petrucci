-- Desempata o preview da lista de conversas internas por `id`.
--
-- Sem o desempate, duas mensagens com o MESMO created_at (mesmo microssegundo,
-- ou qualquer cenário em que os carimbos empatam) deixavam o `ORDER BY
-- created_at DESC LIMIT 1` livre para escolher qualquer uma das duas — então a
-- "última mensagem" mostrada na lista alternava entre elas a cada consulta.
CREATE OR REPLACE FUNCTION public.listar_conversas_internas()
RETURNS TABLE (
  conversa_id uuid,
  outro_user_id uuid,
  outro_nome text,
  outro_department_nome text,
  outro_department_cor text,
  outro_disponivel boolean,
  last_message_at timestamptz,
  last_message_content text,
  last_message_de_mim boolean,
  unread integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    c.id AS conversa_id,
    o.id AS outro_user_id,
    o.nome AS outro_nome,
    d.nome AS outro_department_nome,
    d.cor AS outro_department_cor,
    o.disponivel AS outro_disponivel,
    c.last_message_at,
    ult.content AS last_message_content,
    (ult.sender_user_id = auth.uid()) AS last_message_de_mim,
    COALESCE(cnt.unread, 0)::integer AS unread
  FROM public.conversas_internas c
  JOIN public.users o
    ON o.id = CASE WHEN c.user_a_id = auth.uid() THEN c.user_b_id ELSE c.user_a_id END
  LEFT JOIN public.departments d ON d.id = o.department_id
  LEFT JOIN public.conversa_interna_leituras rl
    ON rl.conversa_id = c.id AND rl.user_id = auth.uid()
  LEFT JOIN LATERAL (
    SELECT m.content, m.sender_user_id
    FROM public.mensagens_internas m
    WHERE m.conversa_id = c.id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ) ult ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS unread
    FROM public.mensagens_internas m
    WHERE m.conversa_id = c.id
      AND m.sender_user_id <> auth.uid()
      AND m.created_at > COALESCE(rl.last_read_at, '-infinity'::timestamptz)
  ) cnt ON true
  WHERE auth.uid() IN (c.user_a_id, c.user_b_id)
  ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.listar_conversas_internas() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_conversas_internas() TO authenticated;
