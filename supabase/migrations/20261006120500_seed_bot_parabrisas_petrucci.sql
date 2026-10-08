-- Dados que o bot de triagem precisa para funcionar na Parabrisas Petrucci.
--
-- O banco foi criado a partir do schema do Almore, sem os dados. Faltavam:
--   - os usuários de sistema Bot ('...001') e Sistema ('...002'). As mensagens
--     do bot gravam sent_by_user_id = Bot (FK para users); sem ele todo envio
--     do bot falha e a triagem entra em loop (ver 20260702182000);
--   - os departamentos do menu, na ordem combinada com o cliente;
--   - os textos do bot para o cliente (editáveis na aba Templates).
--
-- NÃO liga o bot: bot_ativo e o cron triagem-bot ficam como estão (desligados).
-- Idempotente: ON CONFLICT DO NOTHING nunca sobrescreve o que foi editado na tela.
-- company_id entra pelo DEFAULT (empresa única).

-- CHECK da tabela: usuário de sistema exige is_system_user=true e email NULL.
INSERT INTO public.users (id, nome, email, is_system_user, is_superadmin, ativo)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Bot', NULL, true, false, true),
  ('00000000-0000-0000-0000-000000000002', 'Sistema', NULL, true, false, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.departments (nome, cor, ordem)
VALUES
  ('Vendas', '#16a34a', 1),
  ('Suporte', '#2563eb', 2),
  ('Financeiro', '#d97706', 3),
  ('Sem parar', '#7c3aed', 4)
ON CONFLICT (company_id, nome) DO NOTHING;

INSERT INTO public.templates_mensagem (chave, texto, ativo)
VALUES
  (
    'triagem_boas_vindas',
    'Olá! 👋 Você chegou ao atendimento da Parabrisas Petrucci.',
    true
  ),
  (
    'triagem_pergunta_departamento',
    E'Para começar, me diz com qual setor você precisa falar:\n\n{{lista_departamentos}}\n\nÉ só responder com o número da opção.',
    true
  ),
  (
    'triagem_confirmacao',
    'Certo! Te encaminhei para *{{departamento}}*. Em instantes um de nossos atendentes vai te responder. 🙂',
    true
  ),
  (
    'triagem_erro_formato',
    'Não consegui entender sua resposta. 😅 Escolha uma das opções respondendo com o número correspondente.',
    true
  ),
  (
    'triagem_lembrete_sem_resposta',
    'Oi! Ainda está por aí? É só responder com o número do setor que eu te encaminho. 🙂',
    true
  )
ON CONFLICT (company_id, chave) DO NOTHING;
