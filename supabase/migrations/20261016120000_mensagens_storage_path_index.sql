-- Índice para a policy de leitura de mídia (storage.objects).
--
-- `mensagens_midia_select_visivel` faz, para cada link assinado de mídia:
--   EXISTS (SELECT 1 FROM mensagens m WHERE m.media_metadata->>'storage_path' = objects.name)
-- Sem índice nessa expressão, cada pedido varre a tabela inteira aplicando RLS
-- linha a linha. Abrir uma conversa com ~17 imagens dispara 17 varreduras ao
-- mesmo tempo (uma levou 18,9s em 16/10/2026) e o papel `authenticated`, com
-- statement_timeout de 8s, passa a falhar em TUDO: lista de conversas, prévias,
-- contadores de não lidas (erro 57014 / HTTP 500). Resultado visível: depois de
-- "Atribuir a mim" a tela não atualizava e só voltava a funcionar recarregando.
--
-- Índice parcial: só as ~14% de linhas que têm mídia (1.284 de 9.147).
--
-- ATENÇÃO: medido depois de aplicar, o EXPLAIN como `authenticated` continua em
-- Seq Scan. Com RLS ligada, o Postgres só usa índice em filtro do usuário se o
-- operador for "leakproof", e `->>` do jsonb não é. Este índice ajuda consultas
-- feitas por service_role/edge functions, mas NÃO resolve sozinho a policy do
-- storage. O conserto de verdade é trocar o EXISTS da policy por uma função
-- SECURITY DEFINER (decisão pendente, mexe em RLS).

CREATE INDEX IF NOT EXISTS idx_mensagens_storage_path
  ON public.mensagens ((media_metadata ->> 'storage_path'))
  WHERE (media_metadata ->> 'storage_path') IS NOT NULL;
