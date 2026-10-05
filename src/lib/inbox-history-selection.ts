export interface AtendimentoHistoricoCandidate {
  id: string;
  currentDepartmentId: string | null;
  createdAt: string;
  closedAt: string | null;
  assignedToUserId: string | null;
  participantUserIds: string[];
}

/**
 * Escolhe um único atendimento anterior sem abrir o histórico inteiro da empresa:
 * o colaborador pode ver o mesmo setor ou uma conversa da qual participou.
 */
export function selecionarAtendimentoAnterior(params: {
  userId: string;
  currentDepartmentId: string | null;
  candidates: AtendimentoHistoricoCandidate[];
}): AtendimentoHistoricoCandidate | null {
  const elegiveis = params.candidates.filter((candidate) => {
    const mesmoDepartamento =
      params.currentDepartmentId !== null &&
      candidate.currentDepartmentId === params.currentDepartmentId;
    const participou =
      candidate.assignedToUserId === params.userId ||
      candidate.participantUserIds.includes(params.userId);
    return mesmoDepartamento || participou;
  });

  return (
    [...elegiveis].sort((a, b) => {
      const dataA = a.closedAt ?? a.createdAt;
      const dataB = b.closedAt ?? b.createdAt;
      return dataA < dataB ? 1 : dataA > dataB ? -1 : 0;
    })[0] ?? null
  );
}
