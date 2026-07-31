-- Reescreve as descrições dos tempos em system_config.
--
-- Motivo: o João não conseguiu achar na aba Tempos o campo que controla o aviso
-- à responsável quando um cliente fica pendente. Os rótulos antigos descreviam o
-- MECANISMO ("Tempo até alertar sobre atendimento parado") em vez do EFEITO e de
-- QUEM recebe, e dois campos de aviso tinham nomes quase idênticos apesar de
-- terem destinatários diferentes — um deles inclusive morto.
--
-- Os rótulos ficam no frontend (TEMPOS em configuracoes-queries.ts). Aqui vão só
-- as descrições, que a tela lê de system_config.descricao. Nenhum VALOR muda.

UPDATE public.system_config SET descricao =
  'O bot espera esse tanto de segundos depois da última mensagem antes de responder. '
  'Serve para o cliente que manda 4 mensagens picadas receber uma resposta só, em vez de 4.'
 WHERE chave = 'delay_anti_flood_triagem';

UPDATE public.system_config SET descricao =
  'Quantas respostas fora do esperado o cliente pode dar em cada pergunta da triagem. '
  'Ao estourar, o bot para de insistir e encaminha para atendimento humano.'
 WHERE chave = 'triagem_max_tentativas';

UPDATE public.system_config SET descricao =
  'Minutos de silêncio do cliente durante a triagem até o atendimento ser encerrado por abandono. '
  'Hoje só age se o kill switch triagem_abandono_ativo estiver ligado.'
 WHERE chave = 'tempo_abandono_triagem';

-- O campo que o João procurava.
UPDATE public.system_config SET descricao =
  'Quanto tempo um cliente pode ficar pendente ou em triagem sem ninguém assumir antes de o '
  'responsável do setor levar uma cobrança no WhatsApp pessoal. '
  'ATENÇÃO: são minutos ÚTEIS — conta só dentro do expediente do departamento, então à noite, '
  'no fim de semana e no feriado o contador congela. Definido por departamento; sem responsável '
  'definido, o aviso cai na Leticia.'
 WHERE chave = 'tempo_alerta_atendimento_parado';

UPDATE public.system_config SET descricao =
  'De quanto em quanto tempo o responsável do setor é cobrado de novo, enquanto o cliente '
  'seguir esperando. Aumente este valor se os avisos estiverem incomodando.'
 WHERE chave = 'intervalo_repeticao_alerta_atendimento_parado';

UPDATE public.system_config SET descricao =
  'Quanto tempo um cliente pode ficar pendente antes de avisar o número do administrador. '
  'Este é um aviso SEPARADO do aviso ao responsável do setor — vai para um número avulso, '
  'não para um colaborador. Hoje esse número não está cadastrado, então nada é enviado.'
 WHERE chave = 'tempo_notificacao_admin';

UPDATE public.system_config SET descricao =
  'De quanto em quanto tempo o número do administrador é avisado de novo. '
  'Também sem efeito enquanto não houver número cadastrado.'
 WHERE chave = 'intervalo_repeticao_notificacao_admin';

UPDATE public.system_config SET descricao =
  'Minutos sem nenhuma mensagem, de qualquer lado, em um atendimento reservado ou em andamento '
  'até ele ser encerrado sozinho. 1440 = 1 dia.'
 WHERE chave = 'tempo_encerramento_automatico';
