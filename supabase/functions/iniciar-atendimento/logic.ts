// Lógica pura do iniciar-atendimento. Sem I/O, testável sem mockar o Supabase.

export type EscolhaDepartamento =
  | { ok: true; departmentId: string }
  | { ok: false; erro: "departamento_invalido" | "caller_sem_departamento" };

/**
 * Setor da conversa que a própria pessoa inicia para si. Quem tem vários
 * setores escolhe um deles na tela (`pedido`); sem escolha vale o principal.
 */
export function escolherDepartamentoProprio(e: {
  principal: string | null;
  meus: string[];
  pedido: string | null;
}): EscolhaDepartamento {
  if (e.pedido) {
    return e.meus.includes(e.pedido)
      ? { ok: true, departmentId: e.pedido }
      : { ok: false, erro: "departamento_invalido" };
  }
  if (!e.principal) return { ok: false, erro: "caller_sem_departamento" };
  return { ok: true, departmentId: e.principal };
}
