// Lógica pura de criação de atendimento a partir da Lista de Sessões. Sem
// I/O: recebe o que já foi lido do banco (linha de sessoes_triagem, se
// houver) e decide os campos do INSERT em atendimentos. Isolada aqui para
// ser testável sem mockar o Supabase (mesmo padrão de
// alterar-papel-colaborador/logic.ts).

/**
 * - "normal": número não está na Lista de Sessões → triagem normal de cliente.
 * - "sessao": está na lista, roda o fluxo interno (escolhe setor → colaborador).
 * - "sem_triagem": está na lista marcado para pular tudo → cai direto em
 *   Pendentes geral, sem nenhuma mensagem de bot.
 */
export type ModoSessao = "normal" | "sessao" | "sem_triagem";

export interface SessaoTriagemRow {
  sem_triagem: boolean;
}

export function resolverModoSessao(row: SessaoTriagemRow | null): ModoSessao {
  if (!row) return "normal";
  return row.sem_triagem ? "sem_triagem" : "sessao";
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
