-- Add new close_reason for triagem expirada ao virar o dia
ALTER TYPE close_reason ADD VALUE IF NOT EXISTS 'triagem_expirada_dia';

-- Insert system_config flag (default true)
INSERT INTO public.system_config (chave, valor, tipo, descricao)
VALUES (
  'triagem_reinicia_ao_virar_dia',
  'true',
  'booleano',
  'Quando ligado, se o cliente tem um atendimento parado em triagem e manda mensagem em outro dia (fuso America/Sao_Paulo), o atendimento antigo é encerrado e a triagem recomeça num atendimento novo.'
)
ON CONFLICT (chave) DO NOTHING;