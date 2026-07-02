-- Garante os usuários de sistema esperados pelo código.
--
-- Bug: o prod foi criado do zero e nunca recebeu, via migration, os usuários
-- de sistema. A triagem-bot insere mensagens outbound com
-- sent_by_user_id = '00000000-0000-0000-0000-000000000001' (BOT_USER_ID), e
-- mensagens.sent_by_user_id tem FK para users(id). Sem esse usuário, todo
-- envio do bot falhava na persistência (FK 23503) → o estágio da triagem não
-- avançava → o cron reenviava as boas-vindas a cada 10s (loop), e a mensagem
-- nunca aparecia no sistema.
--
-- '...002' é o usuário de sistema usado como sub do JWT em crons
-- (ex.: cron_reativar_bot). Criado por precaução.
--
-- CHECK da tabela: usuário de sistema exige is_system_user=true e email NULL.
-- Idempotente: ON CONFLICT (id) DO NOTHING.

INSERT INTO public.users (id, nome, email, is_system_user, is_superadmin, ativo)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Bot', NULL, true, false, true),
  ('00000000-0000-0000-0000-000000000002', 'Sistema', NULL, true, false, true)
ON CONFLICT (id) DO NOTHING;
