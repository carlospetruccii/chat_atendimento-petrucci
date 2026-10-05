import { describe, expect, test } from "vitest";
import {
  selecionarAtendimentoAnterior,
  type AtendimentoHistoricoCandidate,
} from "./inbox-history-selection";

const USER_ID = "nalanda";

function atendimento(
  id: string,
  closedAt: string,
  over: Partial<AtendimentoHistoricoCandidate> = {},
): AtendimentoHistoricoCandidate {
  return {
    id,
    currentDepartmentId: "dp",
    createdAt: closedAt,
    closedAt,
    assignedToUserId: null,
    participantUserIds: [],
    ...over,
  };
}

describe("selecionarAtendimentoAnterior", () => {
  test("prefere o atendimento mais recente em que o colaborador participou, mesmo em outro setor", () => {
    const resultado = selecionarAtendimentoAnterior({
      userId: USER_ID,
      currentDepartmentId: "dp",
      candidates: [
        atendimento("outro-setor-nao-participou", "2026-09-01T15:00:00Z", {
          currentDepartmentId: "societario",
        }),
        atendimento("conversa-de-hoje", "2026-09-01T13:46:00Z", {
          currentDepartmentId: "atendimento-geral",
          participantUserIds: [USER_ID, "larissa"],
        }),
        atendimento("antigo-do-mesmo-setor", "2026-08-19T12:00:00Z"),
      ],
    });

    expect(resultado?.id).toBe("conversa-de-hoje");
  });

  test("não libera atendimento de outro setor para quem nunca participou", () => {
    const resultado = selecionarAtendimentoAnterior({
      userId: USER_ID,
      currentDepartmentId: "dp",
      candidates: [
        atendimento("outro-setor", "2026-09-01T13:46:00Z", {
          currentDepartmentId: "atendimento-geral",
          participantUserIds: ["larissa"],
        }),
        atendimento("mesmo-setor", "2026-08-19T12:00:00Z"),
      ],
    });

    expect(resultado?.id).toBe("mesmo-setor");
  });

  test("reconhece atribuição direta mesmo quando a timeline legada não tem evento", () => {
    const resultado = selecionarAtendimentoAnterior({
      userId: USER_ID,
      currentDepartmentId: "dp",
      candidates: [
        atendimento("atribuido-diretamente", "2026-09-01T13:46:00Z", {
          currentDepartmentId: "atendimento-geral",
          assignedToUserId: USER_ID,
        }),
      ],
    });

    expect(resultado?.id).toBe("atribuido-diretamente");
  });
});
