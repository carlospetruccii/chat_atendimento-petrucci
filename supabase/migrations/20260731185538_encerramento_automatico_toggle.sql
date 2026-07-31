-- Liga/desliga do encerramento automático por inatividade.
--
-- Até aqui o cron-encerramento-automatico rodava sempre: o único controle era
-- o TEMPO (tempo_encerramento_automatico) e o kill switch global do bot. Não
-- havia como manter o resto da automação de pé e deixar o encerramento 100%
-- manual — a única saída era desagendar o cron por SQL, um estado invisível na
-- tela.
--
-- Nasce DESLIGADO ('false') porque foi exatamente esse o pedido: só
-- encerramento manual. A Edge Function também trata chave ausente como
-- desligado (fail-safe: na dúvida, não encerra a conversa de ninguém).

INSERT INTO public.system_config (chave, valor, tipo, descricao) VALUES
  (
    'encerramento_automatico_ativo',
    'false',
    'booleano',
    'Quando ligado, atendimentos reservados ou em andamento sem nenhuma mensagem por muito tempo são encerrados sozinhos. Desligado, só encerramento manual pelo atendente.'
  )
ON CONFLICT (company_id, chave) DO NOTHING;
