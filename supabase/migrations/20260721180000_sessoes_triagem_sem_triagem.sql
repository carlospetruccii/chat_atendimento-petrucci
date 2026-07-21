-- Lista de Sessões — modo "sem nenhuma triagem".
--
-- Hoje um número da Lista de Sessões sempre roda o fluxo interno (saudação
-- personalizada → escolhe setor → escolhe colaborador). Alguns contatos
-- (ex.: diretoria) não querem NENHUMA interação com o bot: a mensagem deve
-- cair direto na fila geral de Pendentes, como se um humano já tivesse
-- triado. `sem_triagem = false` (default) preserva o comportamento atual
-- para todo mundo que já está na lista.

ALTER TABLE public.sessoes_triagem
  ADD COLUMN IF NOT EXISTS sem_triagem boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sessoes_triagem.sem_triagem IS
  'true = pula o fluxo interno também: o atendimento já nasce concluído (sem mensagem de bot), direto em Pendentes geral. false = roda o fluxo de setor+colaborador (comportamento padrão).';
