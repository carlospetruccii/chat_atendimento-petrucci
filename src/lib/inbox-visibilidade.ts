// Quais conversas a lista do Chat mostra para quem NÃO vê todos os setores.
// Funções puras: a query só aplica o filtro, a tela só decide o botão.

import type { InboxConversation } from "@/lib/inbox-queries";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Filtro `.or()` do PostgREST: as conversas atribuídas à pessoa (em andamento)
 * mais as pendentes ainda sem dono dos setores dela — assim, quando o cliente
 * escolhe o departamento no bot, a conversa já aparece no Chat de quem é do
 * setor, sem precisar abrir a tela Pendentes.
 *
 * Os ids entram no texto do filtro, então só passam UUIDs válidos: qualquer
 * outra coisa é descartada (setor) ou recusada (usuário).
 */
export function filtroConversasVisiveis(userId: string, departmentIds: string[]): string {
  if (!UUID.test(userId)) throw new Error("userId inválido para o filtro do Inbox");
  const atribuidas = `and(assigned_to.eq.${userId},status.in.(reservado,em_atendimento))`;
  const setores = departmentIds.filter((id) => UUID.test(id));
  if (setores.length === 0) return atribuidas;
  const pendentesDoSetor = `and(assigned_to.is.null,status.eq.pendente,current_department_id.in.(${setores.join(",")}))`;
  return `${atribuidas},${pendentesDoSetor}`;
}

/**
 * Conversa pendente de um setor da pessoa, ainda sem dono: ela abre para ler,
 * mas só responde depois de "Atender". Quem vê tudo tem o fluxo de supervisão
 * ("Atribuir a mim"), que já cobre esse caso.
 */
export function podeAtenderPendente(c: InboxConversation, canViewAll: boolean): boolean {
  return !canViewAll && c.status === "pendente" && c.assignedTo === null;
}
