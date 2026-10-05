// Lógica PURA do aviso aos colaboradores quando cai um pendente.
// Sem I/O — testável isoladamente com `deno test`.

// Depto de sistema "triagem": cliente aqui ainda não escolheu setor, não há
// time para avisar.
export const TRIAGEM_DEPT_ID = "00000000-0000-0000-0000-000000000010";

// Um atendimento só é notificável quando já tem um departamento REAL (não nulo
// e não o de triagem).
export function departamentoNotificavel(departmentId: string | null | undefined): boolean {
  const id = (departmentId ?? "").trim();
  return id.length > 0 && id !== TRIAGEM_DEPT_ID;
}

// Quem deve receber o aviso deste atendimento.
export type AlvoAviso =
  | { modo: "setor" }
  | { modo: "reservado"; userId: string };

// Decide o destino do aviso a partir do estado do atendimento:
//  - 'pendente'  → time inteiro do departamento (ainda não tem dono).
//  - 'reservado' → SÓ o dono da reserva. O bot já escolheu a pessoa (último
//    atendente do cliente naquele setor), e mais ninguém pode assumir, então
//    avisar o setor inteiro seria só barulho.
// Qualquer outro status — ou 'reservado' sem dono — não gera aviso.
export function alvoDoAviso(
  status: string | null | undefined,
  assignedTo: string | null | undefined,
): AlvoAviso | null {
  const s = (status ?? "").trim();
  if (s === "pendente") return { modo: "setor" };
  if (s === "reservado") {
    const userId = (assignedTo ?? "").trim();
    return userId ? { modo: "reservado", userId } : null;
  }
  return null;
}

// ── Reserva do bot vs. reserva humana ────────────────────────────────────────
// status='reservado' tem várias origens, e só as automáticas precisam deste
// aviso. Quem é HUMANO grava um timeline_event com ator preenchido:
//   - repassar_atendimento      → 'repassado' (ator ≠ destino)
//   - assign_pendente_a_usuario → 'reservado' (admin atribui, ator ≠ destino)
//     Nesses dois o notificar-repasse já manda o aviso; repetir = mensagem
//     duplicada, e com texto errado ("voltou" não descreve um repasse).
//   - claim_pendente            → 'reservado' com ator = destino (o próprio
//     colaborador clicou "atender"). O notificar-repasse ignora de propósito e
//     nós também devemos: avisar quem acabou de clicar é spam.
//
// Quem é BOT grava nada (triagem-bot finalizarTriagem/aplicarContinuidade) ou
// grava com actor_user_id NULL e outro tipo — 'iniciado_atendimento' na
// continuidade, 'reabertura_automatica' na reabertura. Nenhum desses tipos entra
// na lista abaixo, então a reserva automática segue notificável.
//
// A leitura é segura na ordem do tempo: um evento humano nunca precede a reserva
// do bot na mesma linha, porque 'em_triagem' só é atribuído na criação do
// atendimento — nada devolve um atendimento existente para a triagem.
export const TIPOS_EVENTO_RESERVA_HUMANA = ["repassado", "reservado", "atribuido"];

export interface EventoReservaLike {
  atendimento_id: string;
  target_user_id: string | null;
  actor_user_id: string | null;
}

export function chaveReserva(atendimentoId: string, userId: string): string {
  return `${atendimentoId}:${userId}`;
}

// Indexa as reservas com ator humano, para consulta O(1) no laço. Evento sem
// ator é do bot e NÃO entra — mesmo que o tipo esteja na lista.
export function indexarReservasHumanas(
  eventos: readonly EventoReservaLike[],
): Set<string> {
  const idx = new Set<string>();
  for (const e of eventos) {
    const alvo = (e.target_user_id ?? "").trim();
    const ator = (e.actor_user_id ?? "").trim();
    if (alvo && ator) idx.add(chaveReserva(e.atendimento_id, alvo));
  }
  return idx;
}

export function reservaFeitaPeloBot(
  idx: ReadonlySet<string>,
  atendimentoId: string,
  userId: string,
): boolean {
  return !idx.has(chaveReserva(atendimentoId, userId));
}

export interface ColaboradorLike {
  ativo: boolean | null;
  is_system_user: boolean | null;
  whatsapp: string | null;
}

// Colaborador recebe o aviso se: ativo, não é usuário de sistema e tem WhatsApp
// cadastrado. Um administrador também recebe QUANDO tiver esse departamento
// atribuído — a query que chama esta função já filtra por department_id, então
// um admin sem departamento atribuído nunca aparece aqui.
export function colaboradorRecebe(u: ColaboradorLike): boolean {
  if (u.ativo === false) return false;
  if (u.is_system_user === true) return false;
  return soDigitos(u.whatsapp ?? "").length > 0;
}

// Mantém só dígitos (formato aceito pela uazapi).
export function soDigitos(valor: string): string {
  return (valor ?? "").replace(/\D/g, "");
}

// Telefone do cliente em E.164 com '+' para exibir na mensagem.
export function telefoneExibicao(telefone: string | null | undefined): string {
  const raw = (telefone ?? "").trim();
  if (!raw) return "";
  return raw.startsWith("+") ? raw : `+${soDigitos(raw)}`;
}
