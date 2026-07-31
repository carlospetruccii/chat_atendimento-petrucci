-- Seed das linhas de tempo em system_config.
--
-- Bug: a aba Configurações > Tempos lia 9 chaves de system_config que NUNCA
-- existiram na tabela. Resultado: todos os campos apareciam como 0 (fallback do
-- frontend) e o botão Salvar rodava um `UPDATE ... WHERE chave = $1` que casava
-- ZERO linhas — sem erro, sem gravação. O usuário editava e nada acontecia.
--
-- Enquanto isso as Edge Functions caíam nos defaults hardcoded delas. Os valores
-- abaixo são exatamente esses defaults, então este seed NÃO muda comportamento
-- em produção — só materializa no banco o que já estava valendo, e passa a
-- permitir edição de verdade.
--
-- Defaults de origem:
--   delay_anti_flood_triagem  = 8    (triagem-bot/index.ts)
--   triagem_max_tentativas    = 3    (triagem-bot/index.ts)
--   tempo_abandono_triagem    = 30   (triagem-bot/index.ts)
--   tempo_notificacao_admin   = 60   (cron-notificacao-admin/index.ts)
--   intervalo_repeticao_notificacao_admin = 30 (cron-notificacao-admin/index.ts)
--   tempo_encerramento_automatico = 1440 (cron-encerramento-automatico/index.ts)
--
-- company_id usa o DEFAULT da coluna (instalação single-tenant).

INSERT INTO public.system_config (chave, valor, tipo, descricao) VALUES
  (
    'delay_anti_flood_triagem',
    '8',
    'numero',
    'Segundos que o bot aguarda depois da última mensagem do cliente antes de responder, para agrupar mensagens picadas em uma só resposta.'
  ),
  (
    'triagem_max_tentativas',
    '3',
    'numero',
    'Quantas respostas inválidas o cliente pode dar em cada pergunta da triagem antes do bot desistir e encaminhar para atendimento humano.'
  ),
  (
    'tempo_abandono_triagem',
    '30',
    'numero',
    'Minutos sem resposta do cliente na triagem até o atendimento ser encerrado por abandono. Só age se o kill switch triagem_abandono_ativo estiver ligado.'
  ),
  (
    'tempo_notificacao_admin',
    '60',
    'numero',
    'Minutos que um cliente pode ficar pendente (sem ninguém assumir) antes do administrador ser avisado no WhatsApp.'
  ),
  (
    'intervalo_repeticao_notificacao_admin',
    '30',
    'numero',
    'Minutos entre repetições do aviso ao administrador enquanto o cliente continuar pendente.'
  ),
  (
    'tempo_encerramento_automatico',
    '1440',
    'numero',
    'Minutos sem nenhuma mensagem em um atendimento reservado ou em andamento até ele ser encerrado automaticamente.'
  )
ON CONFLICT (company_id, chave) DO NOTHING;

-- Descrições das duas chaves de alerta de atendimento parado, que já existiam
-- no banco mas não apareciam na aba Tempos. Só normaliza o texto; valor intacto.
UPDATE public.system_config
   SET descricao = 'Minutos úteis sem atendimento (pendente ou triagem) até o responsável ser avisado no WhatsApp pessoal.'
 WHERE chave = 'tempo_alerta_atendimento_parado';

UPDATE public.system_config
   SET descricao = 'Minutos entre repetições do alerta de atendimento parado enquanto o cliente seguir sem atendimento.'
 WHERE chave = 'intervalo_repeticao_alerta_atendimento_parado';
