-- Garante que as chaves de system_config esperadas pelo código existam.
--
-- Bug: o banco de produção foi criado do zero e nunca recebeu, via migration,
-- as chaves 'bot_ativo', 'bot_ativacao_programada' e 'clientes_visivel_para_todos'
-- (elas eram semeadas fora do versionamento). Sem a linha 'bot_ativo':
--   - setBotAtivo() faz UPDATE ... WHERE chave='bot_ativo' -> 0 linhas, sem erro,
--     então o switch de ativar o bot nunca persiste;
--   - o kill-switch (botEstaAtivo) lê a chave ausente e, por fail-safe, trata
--     o bot como DESLIGADO.
-- Mesmo problema latente para 'bot_ativacao_programada' (agendamento) e
-- 'clientes_visivel_para_todos' (visibilidade da aba Clientes).
--
-- Idempotente: ON CONFLICT DO NOTHING não altera nada onde a chave já existe.
-- A PK é composta (company_id, chave); company_id usa o default da tabela.

INSERT INTO public.system_config (chave, valor, tipo, descricao) VALUES
  (
    'bot_ativo',
    'false',
    'booleano',
    'Kill switch global do bot. Quando ligado, a triagem automática roda; quando desligado, toda a automação para.'
  ),
  (
    'bot_ativacao_programada',
    NULL,
    'data',
    'Data ISO opcional para religar o bot automaticamente. NULL = sem agendamento.'
  ),
  (
    'clientes_visivel_para_todos',
    'false',
    'booleano',
    'Quando ligado, colaboradores veem a aba Clientes (somente leitura). Cadastro e importação continuam restritos à administração.'
  )
ON CONFLICT (company_id, chave) DO NOTHING;
