import { describe, expect, test } from "vitest";
import type { InboxConversation } from "@/lib/inbox-queries";
import {
  SETOR_TODOS,
  SETOR_TRIAGEM,
  conversaNoSetor,
  naoLidasPorSetor,
  opcoesDeSetor,
  setorDaConversa,
} from "@/lib/inbox-setor";

const TRIAGEM_ID = "dept-triagem";

function conversa(over: Partial<InboxConversation> = {}): InboxConversation {
  return {
    id: "a1",
    clientId: "c1",
    clientNome: "Cliente",
    clientNumero: "5511999999999",
    clientFotoUrl: null,
    status: "em_atendimento",
    departmentId: "dept-fin",
    departmentNome: "Financeiro",
    departmentCor: "#16a34a",
    assignedTo: null,
    assignedNome: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    unread: 0,
    ...over,
  };
}

const DEPARTAMENTOS = [
  { id: "dept-fin", nome: "Financeiro", cor: "#16a34a" },
  { id: "dept-sp", nome: "Sem Parar", cor: "#2563eb" },
  { id: TRIAGEM_ID, nome: "Triagem", cor: "#64748b" },
  { id: "dept-vendas", nome: "Vendas", cor: "#f59e0b" },
];

describe("setorDaConversa", () => {
  test("devolve o departamento da conversa", () => {
    expect(setorDaConversa(conversa(), TRIAGEM_ID)).toBe("dept-fin");
  });

  test("conversa em triagem cai no balde da triagem", () => {
    const c = conversa({ status: "em_triagem", departmentId: TRIAGEM_ID });
    expect(setorDaConversa(c, TRIAGEM_ID)).toBe(SETOR_TRIAGEM);
  });

  test("conversa sem departamento cai no balde da triagem", () => {
    const c = conversa({ departmentId: null, departmentNome: null });
    expect(setorDaConversa(c, TRIAGEM_ID)).toBe(SETOR_TRIAGEM);
  });

  test("departamento de triagem sem o status em_triagem também é triagem", () => {
    const c = conversa({ status: "pendente", departmentId: TRIAGEM_ID });
    expect(setorDaConversa(c, TRIAGEM_ID)).toBe(SETOR_TRIAGEM);
  });
});

describe("conversaNoSetor", () => {
  test("filtro 'todos' aceita qualquer conversa", () => {
    expect(conversaNoSetor(conversa(), SETOR_TODOS, TRIAGEM_ID)).toBe(true);
    expect(conversaNoSetor(conversa({ departmentId: null }), SETOR_TODOS, TRIAGEM_ID)).toBe(true);
  });

  test("aceita só as conversas do setor escolhido", () => {
    expect(conversaNoSetor(conversa(), "dept-fin", TRIAGEM_ID)).toBe(true);
    expect(conversaNoSetor(conversa(), "dept-sp", TRIAGEM_ID)).toBe(false);
  });

  test("filtro da triagem pega conversa sem departamento", () => {
    const c = conversa({ departmentId: null });
    expect(conversaNoSetor(c, SETOR_TRIAGEM, TRIAGEM_ID)).toBe(true);
    expect(conversaNoSetor(c, "dept-fin", TRIAGEM_ID)).toBe(false);
  });
});

describe("naoLidasPorSetor", () => {
  test("conta conversas com mensagem não lida em cada setor", () => {
    const lista = [
      conversa({ id: "1", unread: 3 }),
      conversa({ id: "2", unread: 1 }),
      conversa({ id: "3", unread: 0 }),
      conversa({ id: "4", departmentId: "dept-sp", unread: 2 }),
      conversa({ id: "5", status: "em_triagem", departmentId: TRIAGEM_ID, unread: 1 }),
    ];
    expect(naoLidasPorSetor(lista, TRIAGEM_ID)).toEqual({
      "dept-fin": 2,
      "dept-sp": 1,
      [SETOR_TRIAGEM]: 1,
    });
  });

  test("lista vazia devolve objeto vazio", () => {
    expect(naoLidasPorSetor([], TRIAGEM_ID)).toEqual({});
  });
});

describe("opcoesDeSetor", () => {
  test("quem vê tudo recebe todos os setores e a triagem no fim", () => {
    const opcoes = opcoesDeSetor(DEPARTAMENTOS, {
      canViewAll: true,
      departmentIds: [],
      triagemDeptId: TRIAGEM_ID,
    });
    expect(opcoes.map((o) => o.id)).toEqual(["dept-fin", "dept-sp", "dept-vendas", SETOR_TRIAGEM]);
    expect(opcoes[opcoes.length - 1].nome).toBe("Triagem");
  });

  test("quem não vê tudo recebe só os próprios setores, sem triagem", () => {
    const opcoes = opcoesDeSetor(DEPARTAMENTOS, {
      canViewAll: false,
      departmentIds: ["dept-sp", "dept-vendas", TRIAGEM_ID],
      triagemDeptId: TRIAGEM_ID,
    });
    expect(opcoes.map((o) => o.id)).toEqual(["dept-sp", "dept-vendas"]);
  });

  test("mantém a ordem recebida dos departamentos", () => {
    const opcoes = opcoesDeSetor([...DEPARTAMENTOS].reverse(), {
      canViewAll: true,
      departmentIds: [],
      triagemDeptId: TRIAGEM_ID,
    });
    expect(opcoes.map((o) => o.id)).toEqual(["dept-vendas", "dept-sp", "dept-fin", SETOR_TRIAGEM]);
  });

  test("sem departamentos e sem permissão de ver tudo não há opções", () => {
    expect(
      opcoesDeSetor([], { canViewAll: false, departmentIds: [], triagemDeptId: TRIAGEM_ID }),
    ).toEqual([]);
  });
});
