// Lógica pura de criação de atendimento a partir das listas de números
// liberados. Sem I/O: recebe o que já foi lido do banco e decide os campos do
// INSERT em atendimentos. Isolada aqui para ser testável sem mockar o Supabase
// (mesmo padrão de alterar-papel-colaborador/logic.ts).
//
// Duas listas INDEPENDENTES (tabelas separadas):
//   - "Sem Triagem" (numeros_sem_triagem): pula TODA interação com o bot.
//   - "Lista de Sessões" (sessoes_triagem): roda o fluxo interno (setor → pessoa).

/**
 * - "normal": número não está em nenhuma lista → triagem normal de cliente.
 * - "sessao": está na Lista de Sessões → fluxo interno (escolhe setor → colaborador).
 * - "sem_triagem": está na lista Sem Triagem → cai direto em Pendentes geral,
 *   sem nenhuma mensagem de bot.
 */
export type ModoSessao = "normal" | "sessao" | "sem_triagem";

/**
 * Decide o modo a partir da presença (ativa) do número em cada lista. "Sem
 * Triagem" tem prioridade: se o número estiver nas duas, pular tudo vence.
 */
export function resolverModo(estaSemTriagem: boolean, estaEmSessao: boolean): ModoSessao {
  if (estaSemTriagem) return "sem_triagem";
  if (estaEmSessao) return "sessao";
  return "normal";
}

export interface NovoAtendimentoFields {
  client_id: string;
  status: "em_triagem";
  current_department_id: null;
  assigned_to: null;
  triagem_started_at: string;
  is_sessao: boolean;
  triagem_estagio?: "concluida";
  triagem_finished_at?: string;
}

// Força o compilador a barrar em tempo de build se um modo novo for
// adicionado a ModoSessao sem atualizar os switches abaixo (em vez de cair
// silenciosamente num branch errado em runtime).
function modoNuncaTratado(modo: never): never {
  throw new Error(`modo de sessão não tratado: ${String(modo)}`);
}

/**
 * Monta os campos do INSERT em atendimentos para uma triagem nova. No modo
 * "sem_triagem" o atendimento já nasce com triagem_estagio='concluida' (o
 * cron do triagem-bot só processa 'aguardando_*', então nunca chega a
 * tocar nesse atendimento) e current_department_id/assigned_to nulos —
 * mesmo padrão que "Pendentes geral" já usa para o caso de zero
 * departamentos cadastrados.
 */
export function montarNovoAtendimento(
  clientId: string,
  modo: ModoSessao,
  agoraIso: string,
): NovoAtendimentoFields {
  const base = {
    client_id: clientId,
    status: "em_triagem" as const,
    current_department_id: null,
    assigned_to: null,
    triagem_started_at: agoraIso,
  };
  switch (modo) {
    case "normal":
      return { ...base, is_sessao: false };
    case "sessao":
      return { ...base, is_sessao: true };
    case "sem_triagem":
      return { ...base, is_sessao: false, triagem_estagio: "concluida", triagem_finished_at: agoraIso };
    default:
      return modoNuncaTratado(modo);
  }
}

/**
 * O fluxo de sessão (setor+colaborador) sempre reinicia do zero — o cliente
 * pode querer falar com pessoas diferentes a cada contato, então não
 * reabre o último atendimento encerrado. "sem_triagem" não tem esse motivo
 * (não há menu nenhum), então segue como cliente normal: reabre se houver
 * um atendimento encerrado por inatividade elegível.
 */
export function devePularReabertura(modo: ModoSessao): boolean {
  switch (modo) {
    case "sessao":
      return true;
    case "normal":
    case "sem_triagem":
      return false;
    default:
      return modoNuncaTratado(modo);
  }
}

// =====================================================================
// Continuidade pós-encerramento
//
// Problema: atendimento encerrado (hoje sempre na mão, o encerramento por
// inatividade está desligado) + cliente responde depois = triagem nova, e o
// cliente leva de novo o menu "escolha o setor" mesmo tendo acabado de falar
// com a gente. A reabertura automática não cobre isso: ela só reabre
// encerramento por inatividade.
//
// Solução: dentro de uma janela configurável, o atendimento novo já nasce com
// o setor da conversa anterior e triagem concluída — o bot nunca é acionado.
// Não reabrimos o atendimento encerrado para não desfazer o encerramento do
// atendente nem sujar as métricas de resolvidos.
// =====================================================================

const MS_POR_HORA = 60 * 60 * 1000;

/** Último atendimento encerrado do cliente, do jeito que sai do banco. */
export interface AtendimentoEncerradoAnterior {
  id: string;
  current_department_id: string | null;
  closed_at: string | null;
}

export interface Continuidade {
  anteriorId: string;
  departmentId: string;
  horasDesdeFechamento: number;
}

/**
 * Decide se a resposta do cliente deve continuar no setor da conversa anterior
 * em vez de passar pelo menu de departamentos.
 *
 * Só vale no modo "normal": "sessao" reinicia sempre (o interno pode querer
 * falar com outra pessoa) e "sem_triagem" já não vê menu nenhum.
 * `janelaHoras <= 0` desliga a continuidade.
 */
export function resolverContinuidade(params: {
  modo: ModoSessao;
  anterior: AtendimentoEncerradoAnterior | null;
  janelaHoras: number;
  agoraIso: string;
}): Continuidade | null {
  const { modo, anterior, janelaHoras, agoraIso } = params;
  if (modo !== "normal") return null;
  if (!anterior?.closed_at || !anterior.current_department_id) return null;
  if (!Number.isFinite(janelaHoras) || janelaHoras <= 0) return null;

  const decorridoMs = new Date(agoraIso).getTime() - new Date(anterior.closed_at).getTime();
  // Negativo = fechamento "no futuro" (relógio torto): não arrisca herdar.
  if (!Number.isFinite(decorridoMs) || decorridoMs < 0) return null;
  const horas = decorridoMs / MS_POR_HORA;
  if (horas > janelaHoras) return null;

  return {
    anteriorId: anterior.id,
    departmentId: anterior.current_department_id,
    horasDesdeFechamento: Math.round(horas * 10) / 10,
  };
}

export interface AtendimentoContinuidadeFields {
  client_id: string;
  status: "pendente" | "reservado";
  current_department_id: string;
  assigned_to: string | null;
  assigned_at?: string;
  is_sessao: false;
  triagem_estagio: "concluida";
  triagem_started_at: string;
  triagem_finished_at: string;
}

/**
 * Monta o INSERT do atendimento que continua a conversa anterior. Espelha o
 * roteamento que a triagem-bot já faz ao concluir (finalizarTriagem): último
 * atendente do cliente naquele setor → reservado para ele; senão → Pendentes
 * do setor.
 */
export function montarAtendimentoContinuidade(
  clientId: string,
  departmentId: string,
  ultimoAtendenteId: string | null,
  agoraIso: string,
): AtendimentoContinuidadeFields {
  const base = {
    client_id: clientId,
    current_department_id: departmentId,
    is_sessao: false as const,
    triagem_estagio: "concluida" as const,
    triagem_started_at: agoraIso,
    triagem_finished_at: agoraIso,
  };
  if (!ultimoAtendenteId) {
    return { ...base, status: "pendente", assigned_to: null };
  }
  return { ...base, status: "reservado", assigned_to: ultimoAtendenteId, assigned_at: agoraIso };
}
