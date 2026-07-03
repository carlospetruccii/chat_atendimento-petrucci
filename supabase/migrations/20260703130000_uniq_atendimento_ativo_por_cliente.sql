-- Corrige a RACE CONDITION que gera atendimentos ATIVOS DUPLICADOS para o mesmo
-- cliente.
--
-- Bug: o webhook (webhook-zapi-receive) é stateless e roda em várias invocações
-- concorrentes. Quando o cliente manda mensagens em rajada, cada invocação
-- executa "busca atendimento ativo → não tem → cria um novo" em paralelo, antes
-- de qualquer uma commitar. Resultado: 2+ atendimentos ativos para o mesmo
-- cliente (confirmado em prod: dois atendimentos criados com 182ms de diferença).
-- Sintomas: boas-vindas duplicadas do bot e, ao encerrar um manualmente, o outro
-- continua em aguardando_departamento e responde "não entendi" à próxima
-- mensagem — que o operador esperava que abrisse uma triagem nova.
--
-- Invariante do domínio: um cliente tem NO MÁXIMO um atendimento ativo por vez
-- (em_triagem/reservado/pendente/em_atendimento). Garantimos isso no banco com
-- um índice único parcial; o webhook passa a tratar o conflito 23505
-- reaproveitando o atendimento vencedor da corrida (ver webhook-zapi-receive).

-- 1) Reconciliação idempotente: fecha duplicatas ativas pré-existentes, mantendo
--    a MAIS RECENTE por cliente. No-op quando não há duplicatas. close_reason
--    'migracao_inicial' também satisfaz o CHECK de departamento em atendimentos
--    sem setor definido.
WITH ativos AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY client_id
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM public.atendimentos
  WHERE status IN ('em_triagem', 'reservado', 'pendente', 'em_atendimento')
)
UPDATE public.atendimentos a
   SET status = 'encerrado',
       closed_at = now(),
       close_reason = 'migracao_inicial',
       triagem_estagio = 'concluida'
  FROM ativos
 WHERE a.id = ativos.id
   AND ativos.rn > 1;

-- 2) Garante no máximo UM atendimento ativo por cliente. Inserts/updates
--    concorrentes que criariam um segundo ativo falham com 23505 e são tratados
--    no código (reaproveita o existente).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_atendimento_ativo_por_cliente
  ON public.atendimentos (client_id)
  WHERE status IN ('em_triagem', 'reservado', 'pendente', 'em_atendimento');

COMMENT ON INDEX public.uniq_atendimento_ativo_por_cliente IS
  'No máximo um atendimento ativo por cliente. Barra a race condition de criação concorrente no webhook.';
