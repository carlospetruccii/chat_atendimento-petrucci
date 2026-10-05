/**
 * Filtro por departamento e por pessoa da dashboard.
 *
 * "Pessoa" não significa a mesma coluna em todo lugar, e é isso que este
 * módulo centraliza:
 *   - atendimento → first_response_user_id: o tempo de primeira resposta é de
 *     quem respondeu, não de quem ficou com a conversa depois de um repasse;
 *   - em aberto   → assigned_to: conversa aberta pode nem ter resposta ainda;
 *   - mensagem    → sent_by_user_id: quem enviou.
 * O RPC dashboard_relacionamento segue a mesma regra no servidor.
 */

export interface DashboardFiltros {
  departmentId: string | null;
  userId: string | null;
}

export const SEM_FILTRO: DashboardFiltros = { departmentId: null, userId: null };

/** Valor do item "Todos" nos selects. Radix Select não aceita value vazio. */
export const TODOS = "todos";

/**
 * Sentinela de "Sem departamento". Conversa sem departamento existe (encerrada
 * ainda na triagem, por exemplo) e sem isso ela não apareceria em filtro
 * nenhum. O RPC entende este uuid zerado como "current_department_id IS NULL";
 * nas queries diretas ele vira um `.is(coluna, null)`.
 */
export const SEM_DEPARTAMENTO = "00000000-0000-0000-0000-000000000000";

export type AlvoFiltro = "atendimento" | "emAberto" | "mensagem";

export interface CondicaoFiltro {
  coluna: string;
  op: "eq" | "is";
  valor: string | null;
}

const COLUNAS: Record<AlvoFiltro, { departamento: string; pessoa: string }> = {
  atendimento: { departamento: "current_department_id", pessoa: "first_response_user_id" },
  emAberto: { departamento: "current_department_id", pessoa: "assigned_to" },
  mensagem: { departamento: "department_id", pessoa: "sent_by_user_id" },
};

export function filtroDeSelect(valor: string): string | null {
  return valor && valor !== TODOS ? valor : null;
}

/** Condições a aplicar numa query do alvo informado. */
export function paresDeFiltro(filtros: DashboardFiltros, alvo: AlvoFiltro): CondicaoFiltro[] {
  const colunas = COLUNAS[alvo];
  const condicoes: CondicaoFiltro[] = [];
  if (filtros.departmentId === SEM_DEPARTAMENTO) {
    condicoes.push({ coluna: colunas.departamento, op: "is", valor: null });
  } else if (filtros.departmentId) {
    condicoes.push({ coluna: colunas.departamento, op: "eq", valor: filtros.departmentId });
  }
  if (filtros.userId) condicoes.push({ coluna: colunas.pessoa, op: "eq", valor: filtros.userId });
  return condicoes;
}
