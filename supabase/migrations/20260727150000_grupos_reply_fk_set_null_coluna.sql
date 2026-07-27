-- Conserta a FK composta da citação: `ON DELETE SET NULL` sem lista de colunas
-- tenta anular TODAS as colunas da FK — incluindo `grupo_id`, que é NOT NULL.
-- Resultado: apagar uma mensagem citada levantaria
-- "null value in column grupo_id violates not-null constraint" em vez de só
-- soltar a citação.
--
-- Hoje isso não aparece (DELETE em grupo_mensagens é bloqueado por trigger para
-- todo mundo menos service_role), mas é uma bomba armada para a primeira limpeza
-- administrativa. PostgreSQL 15+ aceita a lista de colunas — este projeto roda
-- PG 17.
ALTER TABLE public.grupo_mensagens
  DROP CONSTRAINT IF EXISTS grupo_mensagens_reply_same_grupo_fk;

ALTER TABLE public.grupo_mensagens
  ADD CONSTRAINT grupo_mensagens_reply_same_grupo_fk
  FOREIGN KEY (reply_to_message_id, grupo_id)
  REFERENCES public.grupo_mensagens(id, grupo_id)
  ON DELETE SET NULL (reply_to_message_id);
