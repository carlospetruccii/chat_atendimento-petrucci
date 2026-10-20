-- Policy de leitura de mídia (storage.objects) sem varredura da tabela mensagens.
--
-- Problema: `mensagens_midia_select_visivel` fazia um EXISTS direto em `mensagens`.
-- Com RLS ligada, o Postgres não usa o índice `idx_mensagens_storage_path` (o
-- operador `->>` do jsonb não é "leakproof"), então cada link assinado varria a
-- tabela inteira aplicando RLS linha a linha (18,9s medidos em 16/10/2026). Com
-- ~17 imagens abertas ao mesmo tempo, o `authenticated` (statement_timeout 8s)
-- estourava em TUDO: lista de conversas, prévias, contadores (erro 57014 / 500).
--
-- Conserto: mover o EXISTS para uma função SECURITY DEFINER (mesmo padrão de
-- `docs_midia_visivel`). Dentro dela a consulta roda sem RLS e usa o índice, mas a
-- regra de visibilidade é repetida AQUI, igual às policies de `mensagens`:
--   mensagens_select:             is_member_of AND (admin OR mesmo setor OR pendente aberto a todos)
--   mensagens_select_participante: private.can_read_atendimento_participante
-- Qualquer mudança nessas policies precisa ser espelhada nesta função.
-- `auth.uid()` continua sendo o de quem chama (as funções auxiliares o leem do JWT).
--
-- EXECUTE fica no padrão do projeto (igual a `docs_midia_visivel`): a função só
-- responde sobre o que o chamador já enxerga. A policy mantém os mesmos papéis.
--
-- Rollback: ALTER POLICY mensagens_midia_select_visivel ON storage.objects USING (
--   bucket_id = 'mensagens-midia' AND EXISTS (SELECT 1 FROM mensagens m
--   WHERE (m.media_metadata ->> 'storage_path') = objects.name));
--
-- ALTER POLICY (uma instrução, sem janela sem policy) em vez de DROP+CREATE, e
-- lock_timeout para não ficar na fila atrás de consultas lentas.

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.mensagem_midia_visivel(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.mensagens m
    WHERE (m.media_metadata ->> 'storage_path') = p_name
      AND (
        (
          public.is_member_of(m.company_id)
          AND (
            public.can_view_all_in(m.company_id)
            OR m.department_id = public.current_department_in(m.company_id)
            OR (
              public.pendentes_abertos_a_todos(m.company_id)
              AND EXISTS (
                SELECT 1
                FROM public.atendimentos a
                WHERE a.id = m.atendimento_id
                  AND a.assigned_to IS NULL
                  AND a.status = ANY (ARRAY['pendente'::public.status_atendimento, 'em_triagem'::public.status_atendimento])
              )
            )
          )
        )
        OR private.can_read_atendimento_participante(m.atendimento_id, m.company_id)
      )
  )
$function$;

ALTER POLICY mensagens_midia_select_visivel ON storage.objects
  USING (
    bucket_id = 'mensagens-midia'
    AND public.mensagem_midia_visivel(name)
  );
