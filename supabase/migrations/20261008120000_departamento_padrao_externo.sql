-- Setor padrão para conversa que a empresa começa pelo celular.
--
-- Quando alguém responde pelo celular da empresa um cliente sem atendimento
-- aberto, o webhook-zapi-receive cria o atendimento num departamento. Ordem de
-- escolha: config 'triagem_departamento_default' → "Outros" → primeiro ativo
-- por created_at. Os 4 setores da Parabrisas Petrucci nasceram no mesmo
-- INSERT (mesmo created_at), então o "primeiro" ficava indefinido. Fixamos
-- Vendas, que também é a opção 1 do menu.
--
-- NÃO liga o bot nem manda mensagem: só grava a configuração.
-- Idempotente: ON CONFLICT DO NOTHING mantém o valor se alguém já trocou.

INSERT INTO public.system_config (chave, valor, tipo, descricao)
SELECT
  'triagem_departamento_default',
  d.id::text,
  'texto',
  'Departamento das conversas iniciadas pelo celular da empresa (id do departamento).'
FROM public.departments d
WHERE d.company_id = '11111111-1111-1111-1111-111111111111'
  AND d.nome = 'Vendas'
ON CONFLICT (company_id, chave) DO NOTHING;
