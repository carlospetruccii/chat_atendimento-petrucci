-- Faz a aba Templates mostrar TODOS os textos que o sistema pode enviar.
-- Antes só existiam os 5 de triagem; os demais estavam só no código (fallback)
-- ou nem existiam no banco. Os textos abaixo são os mesmos que o código já
-- usa, então nada muda no que é enviado — só passa a dar para editar.
-- notificacao_admin não tinha texto em lugar nenhum: este é novo.
-- Idempotente: nunca sobrescreve texto que alguém já editou.
--
-- Rollback:
--   DELETE FROM public.templates_mensagem WHERE chave IN (
--     'sessao_boas_vindas','sessao_pergunta_departamento','sessao_pergunta_colaborador',
--     'sessao_confirmacao','notificacao_colaborador','notificacao_colaborador_reservado',
--     'alerta_atendimento_parado','notificacao_admin');

INSERT INTO public.templates_mensagem (company_id, chave, texto, variacoes, ativo)
SELECT c.id, t.chave, t.texto, ARRAY[]::text[], true
FROM public.companies c
CROSS JOIN (VALUES
  ('sessao_boas_vindas',
   E'Olá, {{nome}}! 👋'),
  ('sessao_pergunta_departamento',
   E'Com qual setor você quer falar?\n\n{{lista_departamentos}}\n\nÉ só responder com o número da opção.'),
  ('sessao_pergunta_colaborador',
   E'Perfeito! Com qual pessoa do setor *{{departamento}}* você quer falar?\n\n{{lista_colaboradores}}\n\nÉ só responder com o número da opção.'),
  ('sessao_confirmacao',
   E'Certo! Te encaminhei para *{{colaborador}}*. Em instantes essa pessoa vai te responder. 🙂'),
  ('notificacao_colaborador',
   E'🔔 *Novo cliente aguardando*\n\nO cliente *{{nome_cliente}}* ({{telefone}}) quer ser atendido no setor {{departamento}}.'),
  ('notificacao_colaborador_reservado',
   E'🔔 *Novo cliente pra você*\n\n*{{nome_cliente}}* ({{telefone}}) voltou e foi direcionado(a) pra você no setor {{departamento}}.'),
  ('alerta_atendimento_parado',
   E'⏰ *Atendimento sem resposta*\n\nO cliente *{{nome_cliente}}* ({{telefone}}) está há {{tempo_aguardando}} sem atendimento no setor {{departamento}}.'),
  ('notificacao_admin',
   E'⚠️ *Cliente aguardando atendimento*\n\nO cliente *{{nome_cliente}}* ({{telefone}}) está há {{tempo_aguardando}} esperando no setor {{departamento}}.')
) AS t(chave, texto)
ON CONFLICT (company_id, chave) DO NOTHING;
