// Filtro por setor da lista de conversas do Inbox. Funções puras: a tela só
// escolhe o setor e mostra o resultado.

import type { InboxConversation } from "@/lib/inbox-queries";

/** Sem filtro de setor. */
export const SETOR_TODOS = "todos";
/** Conversas que ainda não têm setor (o cliente não respondeu o menu do bot). */
export const SETOR_TRIAGEM = "triagem";

/** `SETOR_TODOS`, `SETOR_TRIAGEM` ou o id de um departamento. */
export type SetorFiltro = string;

export interface DepartamentoInbox {
  id: string;
  nome: string;
  cor: string | null;
}

export interface OpcaoSetor {
  id: SetorFiltro;
  nome: string;
  cor: string | null;
}

/** Setor "efetivo" da conversa: triagem/sem departamento viram `SETOR_TRIAGEM`. */
export function setorDaConversa(c: InboxConversation, triagemDeptId: string): SetorFiltro {
  if (c.status === "em_triagem" || !c.departmentId || c.departmentId === triagemDeptId) {
    return SETOR_TRIAGEM;
  }
  return c.departmentId;
}

export function conversaNoSetor(
  c: InboxConversation,
  filtro: SetorFiltro,
  triagemDeptId: string,
): boolean {
  return filtro === SETOR_TODOS || setorDaConversa(c, triagemDeptId) === filtro;
}

/** Quantas conversas com mensagem não lida cada setor tem. */
export function naoLidasPorSetor(
  conversas: InboxConversation[],
  triagemDeptId: string,
): Record<SetorFiltro, number> {
  const contagem: Record<SetorFiltro, number> = {};
  for (const c of conversas) {
    if (c.unread <= 0) continue;
    const setor = setorDaConversa(c, triagemDeptId);
    contagem[setor] = (contagem[setor] ?? 0) + 1;
  }
  return contagem;
}

interface OpcoesDeSetorParams {
  canViewAll: boolean;
  /** Setores da pessoa — só importam para quem não vê tudo. */
  departmentIds: string[];
  triagemDeptId: string;
}

/**
 * Pills de setor da lista. Quem vê tudo recebe todos os setores (na ordem
 * recebida) mais a triagem no fim; os demais, só os próprios setores — eles
 * nunca veem conversa em triagem.
 */
export function opcoesDeSetor(
  departamentos: DepartamentoInbox[],
  { canViewAll, departmentIds, triagemDeptId }: OpcoesDeSetorParams,
): OpcaoSetor[] {
  const proprios = new Set(departmentIds);
  const setores = departamentos
    .filter((d) => d.id !== triagemDeptId)
    .filter((d) => canViewAll || proprios.has(d.id))
    .map(({ id, nome, cor }) => ({ id, nome, cor }));
  return canViewAll ? [...setores, { id: SETOR_TRIAGEM, nome: "Triagem", cor: null }] : setores;
}
