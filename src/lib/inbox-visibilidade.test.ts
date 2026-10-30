import { describe, expect, test } from "vitest";
import { filtroConversasVisiveis, podeAtenderPendente } from "@/lib/inbox-visibilidade";
import type { InboxConversation } from "@/lib/inbox-queries";

const USER = "11111111-1111-4111-8111-111111111111";
const DEPT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEPT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function conversa(over: Partial<InboxConversation> = {}): InboxConversation {
  return {
    id: "a1",
    clientId: "c1",
    clientNome: "Cliente",
    clientNumero: "5511999999999",
    clientFotoUrl: null,
    status: "pendente",
    departmentId: DEPT_A,
    departmentNome: "Financeiro",
    departmentCor: null,
    assignedTo: null,
    assignedNome: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    unread: 0,
    ...over,
  };
}

describe("filtroConversasVisiveis", () => {
  test("inclui as atribuídas à pessoa e as pendentes dos setores dela", () => {
    const filtro = filtroConversasVisiveis(USER, [DEPT_A, DEPT_B]);

    expect(filtro).toBe(
      `and(assigned_to.eq.${USER},status.in.(reservado,em_atendimento)),` +
        `and(assigned_to.is.null,status.eq.pendente,current_department_id.in.(${DEPT_A},${DEPT_B}))`,
    );
  });

  test("sem setores, só as atribuídas à pessoa", () => {
    expect(filtroConversasVisiveis(USER, [])).toBe(
      `and(assigned_to.eq.${USER},status.in.(reservado,em_atendimento))`,
    );
  });

  test("ignora ids de setor que não são UUID (nada entra no filtro cru)", () => {
    const filtro = filtroConversasVisiveis(USER, [DEPT_A, "x),assigned_to.not.is.null,(y"]);

    expect(filtro).toContain(`current_department_id.in.(${DEPT_A})`);
    expect(filtro).not.toContain("not.is.null");
  });

  test("id de usuário que não é UUID derruba o filtro com erro", () => {
    expect(() => filtroConversasVisiveis("x,or(y)", [DEPT_A])).toThrow();
  });
});

describe("podeAtenderPendente", () => {
  test("pendente sem dono, para quem não vê tudo, é para atender", () => {
    expect(podeAtenderPendente(conversa(), false)).toBe(true);
  });

  test("quem vê tudo usa o fluxo de supervisão, não este", () => {
    expect(podeAtenderPendente(conversa(), true)).toBe(false);
  });

  test("conversa já atribuída (a mim ou a outro) não é pendente de atender", () => {
    const minha = conversa({ status: "em_atendimento", assignedTo: USER });
    const dosOutros = conversa({ status: "em_atendimento", assignedTo: "outro" });

    expect(podeAtenderPendente(minha, false)).toBe(false);
    expect(podeAtenderPendente(dosOutros, false)).toBe(false);
  });

  test("status diferente de pendente não é para atender", () => {
    const c = conversa({ status: "encerrado" });

    expect(podeAtenderPendente(c, false)).toBe(false);
  });
});
