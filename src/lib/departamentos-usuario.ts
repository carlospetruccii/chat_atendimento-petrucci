// Departamentos de cada pessoa (tabela user_departments). Uma pessoa pode ter
// vários; o principal (users.department_id) vem sempre primeiro.

const FALLBACK_COR = "#64748b";
export const SEM_DEPARTAMENTO_NOME = "Sem departamento";

export interface DepartamentoResumo {
  id: string;
  nome: string;
  cor: string;
}

export interface VinculoDepartamento {
  user_id: string;
  department_id: string;
  departments: { nome: string; cor: string | null } | null;
}

/** Agrupa os vínculos por pessoa: principal primeiro, os demais por nome. */
export function departamentosPorUsuario(
  vinculos: VinculoDepartamento[],
  principalPorUsuario: Map<string, string | null>,
): Map<string, DepartamentoResumo[]> {
  const porUsuario = new Map<string, DepartamentoResumo[]>();
  for (const v of vinculos) {
    const lista = porUsuario.get(v.user_id) ?? [];
    porUsuario.set(v.user_id, [
      ...lista,
      {
        id: v.department_id,
        nome: v.departments?.nome ?? "—",
        cor: v.departments?.cor ?? FALLBACK_COR,
      },
    ]);
  }
  const ordenado = new Map<string, DepartamentoResumo[]>();
  for (const [userId, lista] of porUsuario) {
    const principal = principalPorUsuario.get(userId) ?? null;
    ordenado.set(
      userId,
      [...lista].sort((a, b) => {
        if (a.id === principal) return -1;
        if (b.id === principal) return 1;
        return a.nome.localeCompare(b.nome, "pt-BR");
      }),
    );
  }
  return ordenado;
}

export interface GrupoDepartamento<T> {
  /** null = pessoas sem nenhum setor. */
  departmentId: string | null;
  nome: string;
  pessoas: T[];
}

/**
 * Listas de escolha (repassar/atribuir): cada pessoa aparece em cada setor
 * dela; quem não tem setor vai para "Sem departamento", no fim.
 */
export function agruparPorDepartamento<
  T extends { nome: string; departamentos: { id: string; nome: string }[] },
>(pessoas: T[], busca: string): GrupoDepartamento<T>[] {
  const termo = busca.trim().toLowerCase();
  const grupos = new Map<string, GrupoDepartamento<T>>();
  const semDepartamento: T[] = [];
  for (const p of pessoas) {
    if (termo && !p.nome.toLowerCase().includes(termo)) continue;
    if (p.departamentos.length === 0) {
      semDepartamento.push(p);
      continue;
    }
    for (const d of p.departamentos) {
      const grupo = grupos.get(d.id) ?? { departmentId: d.id, nome: d.nome, pessoas: [] };
      grupos.set(d.id, { ...grupo, pessoas: [...grupo.pessoas, p] });
    }
  }
  const lista = [...grupos.values()];
  return semDepartamento.length > 0
    ? [...lista, { departmentId: null, nome: SEM_DEPARTAMENTO_NOME, pessoas: semDepartamento }]
    : lista;
}

/** Mesma lista na mesma ordem (a ordem importa: o 1º é o principal). */
export function mesmosDepartamentos(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
