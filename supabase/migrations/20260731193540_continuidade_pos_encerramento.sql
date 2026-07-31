-- Continuidade pós-encerramento: cliente que responde depois de um atendimento
-- encerrado não leva o menu de departamentos de novo.
--
-- Problema: quando um departamento inicia a conversa (ou o cliente já foi
-- atendido) e o atendimento é encerrado, a resposta seguinte do cliente cria uma
-- triagem nova e o bot pergunta "escolha o setor" para quem acabou de falar com
-- a gente. Nos 7 dias anteriores a esta migration, dos 41 menus de setor
-- enviados, ZERO eram cliente novo — 35 tinham atendimento encerrado na mão.
--
-- A reabertura automática que já existia não cobre isso: ela só reabre
-- encerramento com close_reason='automatico_inatividade', e o encerramento
-- automático está desligado (encerramento_automatico_ativo='false'), então esse
-- motivo não é mais gerado.
--
-- Comportamento novo (webhook-zapi-receive): se o último atendimento encerrado
-- do cliente tem setor e foi fechado dentro desta janela, o atendimento novo
-- nasce JÁ nesse setor com triagem_estagio='concluida' — o bot nunca é
-- acionado. O atendimento encerrado NÃO é reaberto, para não desfazer o
-- encerramento do atendente nem sujar a contagem de resolvidos.
--
-- 0 = desliga a continuidade (volta ao comportamento anterior, sempre triagem).

INSERT INTO public.system_config (chave, valor, tipo, descricao) VALUES
  (
    'janela_continuidade_apos_encerramento',
    '72',
    'numero',
    'Por quantas horas depois de um atendimento encerrado a resposta do cliente '
    'continua no MESMO setor, sem o bot perguntar o departamento de novo. '
    'Se o atendente que cuidou dele ainda estiver ativo e disponível, o '
    'atendimento volta reservado para ele; senão cai em Pendentes do setor. '
    'Passada a janela, o cliente entra em triagem normal. 0 = desligado.'
  )
ON CONFLICT (company_id, chave) DO NOTHING;
