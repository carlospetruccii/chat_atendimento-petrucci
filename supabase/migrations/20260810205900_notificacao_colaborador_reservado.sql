-- Aviso ao colaborador quando o BOT reserva um atendimento pra ele.
--
-- Ponto cego que isso corrige: quando a triagem termina (triagem-bot
-- finalizarTriagem / aplicarContinuidadeSeAplicavel) ou a continuidade
-- pós-encerramento cria o atendimento (webhook-zapi-receive), se o cliente já
-- tem "último atendente" naquele setor o atendimento nasce com
-- status='reservado' + assigned_to preenchido — nunca passa por 'pendente'.
-- O cron-notificacao-colaboradores só olhava 'pendente', e o notificar-repasse
-- exige um ator humano (actor_user_id <> target_user_id), então NINGUÉM era
-- avisado no WhatsApp. Entre 27/07 e 10/08/2026, 19 atendimentos caíram nesse
-- vão (reserva automática sem nenhum timeline_event de ator humano) — ~1,3 por
-- dia. Os demais 'reservado' do período vieram de ação humana (claim_pendente,
-- repasse, atribuição) e já eram cobertos.
--
-- Comportamento novo: o cron também pega 'reservado' e avisa SÓ o dono da
-- reserva (avisar o setor inteiro seria barulho — mais ninguém pode assumir).
-- Reserva feita por HUMANO (repassar_atendimento, assign_pendente_a_usuario,
-- claim_pendente) é filtrada na função: essas gravam timeline_event com ator, e
-- o notificar-repasse já cuida delas.
--
-- ATENÇÃO (reversibilidade): assim que existir um par de linhas
-- (atendimento, depto, NULL) + (atendimento, depto, user), a constraint antiga
-- de 2 colunas não pode mais ser recriada sem apagar linhas do ledger. Reverter
-- o schema exige limpar o ledger primeiro.

-- Locks: o ADD COLUMN com FK pega ShareRowExclusive em public.users (que tem
-- trigger e escrita do app). Preferimos falhar rápido e re-rodar a virar cabeça
-- de fila bloqueando escrita em users.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- ── Ledger: passa a distinguir o destino do aviso.
--   destino_user_id NULL   → aviso ao setor inteiro (atendimento 'pendente')
--   destino_user_id setado → aviso só ao dono da reserva ('reservado')
-- Sem essa coluna na chave, avisar a reserva trancaria o par
-- (atendimento, departamento) e o time ficaria sem aviso se o atendimento fosse
-- liberado depois — release_atendimentos_on_user_inactive devolve
-- reservado → pendente quando o colaborador é desativado.
ALTER TABLE public.notificacoes_colaborador_pendente
  ADD COLUMN IF NOT EXISTS destino_user_id uuid
    REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.notificacoes_colaborador_pendente
  DROP CONSTRAINT IF EXISTS notif_colab_pendente_uniq_atend_dept;

-- NULLS NOT DISTINCT (PG15+): duas linhas com destino_user_id NULL colidem, que
-- é exatamente o "uma vez por (atendimento, departamento)" do aviso ao setor.
CREATE UNIQUE INDEX IF NOT EXISTS notif_colab_pendente_uniq_atend_dept_destino
  ON public.notificacoes_colaborador_pendente
     (atendimento_id, department_id, destino_user_id)
  NULLS NOT DISTINCT;

COMMENT ON COLUMN public.notificacoes_colaborador_pendente.destino_user_id IS
  'NULL = aviso ao setor inteiro (atendimento pendente). Preenchido = aviso só ao dono da reserva (atendimento reservado pelo bot).';

COMMENT ON TABLE public.notificacoes_colaborador_pendente IS
  'Ledger do aviso no WhatsApp pessoal quando um cliente entra na fila. Uma linha por (atendimento, departamento, destino): destino NULL = setor inteiro (pendente), destino preenchido = dono da reserva (reservado). Escrito só pelo backend (cron-notificacao-colaboradores).';

-- ── Anti-rajada: 'reservado' nunca esteve no ledger, então TODA reserva aberta
-- hoje seria vista como "nunca avisada" e levaria um zap retroativo no primeiro
-- tick. Ninguém espera aviso de estado antigo — semeamos o ledger como se já
-- tivessem sido avisadas. A instância da uazapi é compartilhada com outro
-- sistema, então rajada aqui é risco de 429 para os dois.
-- (Sem efeito se não houver reserva aberta no momento da aplicação.)
INSERT INTO public.notificacoes_colaborador_pendente
  (atendimento_id, department_id, company_id, destino_user_id)
SELECT a.id, a.current_department_id, a.company_id, a.assigned_to
  FROM public.atendimentos a
 WHERE a.status = 'reservado'
   AND a.assigned_to IS NOT NULL
   AND a.current_department_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── Template do aviso de reserva (a função tem fallback embutido se sumir).
INSERT INTO public.templates_mensagem (company_id, chave, texto, variacoes, ativo)
SELECT c.id, 'notificacao_colaborador_reservado',
  E'🔔 *Novo cliente pra você*\n\n*{{nome_cliente}}* ({{telefone}}) voltou e foi direcionado(a) pra você no setor {{departamento}}.',
  ARRAY[]::text[], true
FROM public.companies c
ON CONFLICT (company_id, chave) DO NOTHING;
