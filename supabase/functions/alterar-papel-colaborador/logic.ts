// Lógica pura da troca de papel (admin ↔ colaborador). Sem I/O: recebe o estado
// já lido do banco e decide o resultado ou o motivo da recusa. Fica isolada aqui
// para ser testável sem mockar o Supabase.

export type Papel = "dono" | "administrador" | "colaborador";

export interface EntradaTroca {
  /** Papel canônico de quem chamou (só o dono pode trocar papéis). */
  callerRole: Papel | null;
  callerId: string;
  /** Alvo da troca. */
  targetId: string;
  targetExists: boolean;
  /** Papel atual do alvo (null se não for membro ativo). */
  targetRole: Papel | null;
  /** Papel desejado. */
  novoRole: string;
  /** Departamento informado (obrigatório para colaborador). */
  departmentId: string | null;
}

export type ResultadoTroca =
  | { ok: false; status: number; error: string }
  | { ok: true; isAdmin: boolean; departmentId: string | null };

/**
 * Decide se a troca de papel é permitida e, se for, o estado resultante
 * (is_superadmin + departamento). Regras:
 *  - Só o dono troca papéis (bate com a RLS de company_members).
 *  - Não se pode trocar o próprio papel nem o de outro dono.
 *  - Papel válido é apenas 'administrador' ou 'colaborador'.
 *  - Colaborador exige departamento; administrador não tem departamento.
 */
export function resolverTrocaPapel(e: EntradaTroca): ResultadoTroca {
  if (e.callerRole !== "dono") {
    return { ok: false, status: 403, error: "Apenas o dono pode alterar papéis." };
  }
  if (e.novoRole !== "administrador" && e.novoRole !== "colaborador") {
    return {
      ok: false,
      status: 400,
      error: "Papel inválido (use 'administrador' ou 'colaborador').",
    };
  }
  if (!e.targetExists || e.targetRole === null) {
    return { ok: false, status: 404, error: "Colaborador não encontrado." };
  }
  if (e.targetId === e.callerId) {
    return { ok: false, status: 400, error: "Você não pode alterar o seu próprio papel." };
  }
  if (e.targetRole === "dono") {
    return { ok: false, status: 400, error: "O papel de dono não pode ser alterado por aqui." };
  }

  const isAdmin = e.novoRole === "administrador";
  const departmentId = isAdmin ? null : (e.departmentId ?? "").trim() || null;

  if (!isAdmin && !departmentId) {
    return { ok: false, status: 400, error: "Colaborador exige um departamento." };
  }

  return { ok: true, isAdmin, departmentId };
}
