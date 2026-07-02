-- Triagem por DEPARTAMENTO — textos padrão do bot.
-- O bot pergunta SÓ o departamento: saudação → menu de departamentos →
-- confirmação de encaminhamento. Estes templates não existiam no banco ainda
-- (só `triagem_lembrete_sem_resposta` estava semeado), então sem eles o bot
-- não conseguia enviar as mensagens da triagem.
--
-- Idempotente: ON CONFLICT DO NOTHING nunca sobrescreve texto editado pelo dono.
-- company_id entra pelo DEFAULT ('Empresa Exemplo'); a unicidade é (company_id, chave).

INSERT INTO public.templates_mensagem (chave, texto, ativo)
VALUES
  (
    'triagem_boas_vindas',
    'Olá! 👋 Você chegou ao atendimento da Almore.',
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
  )
ON CONFLICT (company_id, chave) DO NOTHING;
