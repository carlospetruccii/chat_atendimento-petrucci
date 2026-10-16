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
  /** Departamentos informados, já validados (o 1º é o principal). Colaborador exige ao menos um. */
  departmentIds: string[];
}

export type ResultadoTroca =
  | { ok: false; status: number; error: string }
  | { ok: true; isAdmin: boolean; departmentIds: string[] };

/**
 * Decide se a troca de papel é permitida e, se for, o estado resultante
 * (is_superadmin + departamentos). Regras:
 *  - Só o dono troca papéis (bate com a RLS de company_members).
 *  - Não se pode trocar o próprio papel nem o de outro dono.
 *  - Papel válido é apenas 'administrador' ou 'colaborador'.
 *  - Colaborador exige ao menos um departamento. Administrador pode ter
 *    departamentos atribuídos (opcional) — continua enxergando tudo, mas passa a
 *    receber os avisos de novo pendente desses setores como um colaborador deles.
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
  const departmentIds = e.departmentIds;

  if (!isAdmin && departmentIds.length === 0) {
    return { ok: false, status: 400, error: "Colaborador exige um departamento." };
  }

  return { ok: true, isAdmin, departmentIds };
}
