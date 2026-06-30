
ALTER TABLE public.atendimentos
  ADD COLUMN IF NOT EXISTS triagem_lembrete_enviado_at timestamptz;

INSERT INTO public.system_config (chave, valor, tipo, descricao)
VALUES
  ('triagem_lembrete_ativo', 'true', 'booleano', 'Se ligado, envia lembrete único quando o cliente não responde a triagem dentro do tempo configurado'),
  ('triagem_lembrete_minutos', '30', 'numero', 'Minutos de espera sem resposta na triagem antes de enviar o lembrete')
ON CONFLICT (chave) DO NOTHING;

INSERT INTO public.templates_mensagem (chave, texto, ativo)
VALUES (
  'triagem_lembrete_sem_resposta',
  'Oi! Você ainda está aí? 😊 Por favor, responda a opção do menu acima para que eu possa te direcionar ao atendimento certo.',
  true
)
ON CONFLICT (chave) DO NOTHING;
