-- Fluxo da Lista de Sessões — marca no atendimento + templates das mensagens.
--
-- Um atendimento nascido de um número da Lista de Sessões roda um fluxo
-- diferente do cliente comum: saudação PERSONALIZADA (com o nome cadastrado)
-- → escolha do departamento → escolha do COLABORADOR daquele departamento →
-- atendimento reservado direto para a pessoa escolhida.
--
-- is_sessao carimba o atendimento na criação (webhook) para o triagem-bot saber
-- qual fluxo aplicar. Idempotente.

ALTER TABLE public.atendimentos
  ADD COLUMN IF NOT EXISTS is_sessao boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.atendimentos.is_sessao IS
  'true quando o atendimento veio de um número da Lista de Sessões (fluxo interno: escolhe departamento e depois o colaborador).';

-- Templates das mensagens do fluxo de sessão. ON CONFLICT DO NOTHING para nunca
-- sobrescrever texto que o dono já editou. company_id entra pelo DEFAULT.
INSERT INTO public.templates_mensagem (chave, texto, ativo)
VALUES
  (
    'sessao_boas_vindas',
    'Olá, {{nome}}! 👋',
    true
  ),
  (
    'sessao_pergunta_departamento',
    E'Com qual setor você quer falar?\n\n{{lista_departamentos}}\n\nÉ só responder com o número da opção.',
    true
  ),
  (
    'sessao_pergunta_colaborador',
    E'Perfeito! Com qual pessoa do setor *{{departamento}}* você quer falar?\n\n{{lista_colaboradores}}\n\nÉ só responder com o número da opção.',
    true
  ),
  (
    'sessao_confirmacao',
    'Certo! Te encaminhei para *{{colaborador}}*. Em instantes essa pessoa vai te responder. 🙂',
    true
  )
ON CONFLICT (company_id, chave) DO NOTHING;
