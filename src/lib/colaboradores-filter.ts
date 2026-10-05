export interface ColaboradorFiltravel {
  id: string;
  nome: string;
  email: string | null;
  department_id: string | null;
  status: "ativo" | "indisponivel" | "inativo";
}

interface FiltrosColaboradores {
  busca: string;
  departamentoId: string;
  status: "Todos" | "ativo" | "indisponivel";
  mostrarInativos: boolean;
}

export function filtrarColaboradores<T extends ColaboradorFiltravel>(
  colaboradores: T[],
  { busca, departamentoId, status, mostrarInativos }: FiltrosColaboradores,
): T[] {
  const buscaNormalizada = busca.trim().toLowerCase();

  return colaboradores.filter((colaborador) => {
    if (
      buscaNormalizada &&
      !colaborador.nome.toLowerCase().includes(buscaNormalizada) &&
      !(colaborador.email ?? "").toLowerCase().includes(buscaNormalizada)
    )
      return false;
    if (departamentoId !== "Todos" && colaborador.department_id !== departamentoId) return false;
    if (status !== "Todos" && colaborador.status !== status) return false;
    return mostrarInativos || colaborador.status !== "inativo";
  });
}
