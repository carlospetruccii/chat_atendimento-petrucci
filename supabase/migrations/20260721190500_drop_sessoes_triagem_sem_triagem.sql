-- Remove a coluna sem_triagem de sessoes_triagem.
--
-- Ela foi adicionada por engano em 20260721180000 (misturava o conceito de "sem
-- triagem nenhuma" dentro da Lista de Sessões). Agora "Sem Triagem" é uma lista
-- própria e separada (numeros_sem_triagem, 20260721190000), então a coluna não
-- faz mais sentido aqui. Forward-only: não reescreve a migration antiga.

ALTER TABLE public.sessoes_triagem
  DROP COLUMN IF EXISTS sem_triagem;
