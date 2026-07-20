-- Seeds do alerta de atendimento parado, por empresa (idempotente).
-- Sem IDs hardcoded: insere para todas as empresas existentes.

-- Configs de tempo (a Edge Function tem defaults 90/30 caso faltem).
INSERT INTO public.system_config (company_id, chave, valor, tipo, descricao)
SELECT c.id, 'tempo_alerta_atendimento_parado', '90', 'numero',
       'Minutos sem atendimento (pendente/triagem) até avisar o responsável no WhatsApp pessoal.'
FROM public.companies c
ON CONFLICT (company_id, chave) DO NOTHING;

INSERT INTO public.system_config (company_id, chave, valor, tipo, descricao)
SELECT c.id, 'intervalo_repeticao_alerta_atendimento_parado', '30', 'numero',
       'Minutos entre repetições do alerta de atendimento parado enquanto o cliente seguir sem atendimento.'
FROM public.companies c
ON CONFLICT (company_id, chave) DO NOTHING;

-- Template do aviso (a função tem um texto-fallback embutido se este sumir).
INSERT INTO public.templates_mensagem (company_id, chave, texto, variacoes, ativo)
SELECT c.id, 'alerta_atendimento_parado',
  E'⏰ *Atendimento sem resposta*\n\nO cliente *{{nome_cliente}}* ({{telefone}}) está há {{tempo_aguardando}} sem atendimento no setor {{departamento}}.',
  ARRAY[]::text[], true
FROM public.companies c
ON CONFLICT (company_id, chave) DO NOTHING;
