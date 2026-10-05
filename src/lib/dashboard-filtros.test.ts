import { describe, expect, test } from "vitest";
import {
  SEM_DEPARTAMENTO,
  SEM_FILTRO,
  TODOS,
  filtroDeSelect,
  paresDeFiltro,
} from "./dashboard-filtros";

describe("filtroDeSelect", () => {
  test("'todos' vira null (sem filtro)", () => {
    expect(filtroDeSelect(TODOS)).toBeNull();
  });

  test("string vazia vira null", () => {
    expect(filtroDeSelect("")).toBeNull();
  });

  test("id escolhido passa direto", () => {
    expect(filtroDeSelect("abc-123")).toBe("abc-123");
  });
});

describe("paresDeFiltro", () => {
  const ambos = { departmentId: "d1", userId: "u1" };

  test("sem filtro não gera condição nenhuma", () => {
    expect(paresDeFiltro(SEM_FILTRO, "atendimento")).toEqual([]);
    expect(paresDeFiltro(SEM_FILTRO, "emAberto")).toEqual([]);
    expect(paresDeFiltro(SEM_FILTRO, "mensagem")).toEqual([]);
  });

  test("atendimento: pessoa é quem respondeu primeiro", () => {
    expect(paresDeFiltro(ambos, "atendimento")).toEqual([
      { coluna: "current_department_id", op: "eq", valor: "d1" },
      { coluna: "first_response_user_id", op: "eq", valor: "u1" },
    ]);
  });

  test("em aberto: pessoa é quem está com a conversa (ainda pode não ter resposta)", () => {
    expect(paresDeFiltro(ambos, "emAberto")).toEqual([
      { coluna: "current_department_id", op: "eq", valor: "d1" },
      { coluna: "assigned_to", op: "eq", valor: "u1" },
    ]);
  });

  test("mensagem: pessoa é quem enviou", () => {
    expect(paresDeFiltro(ambos, "mensagem")).toEqual([
      { coluna: "department_id", op: "eq", valor: "d1" },
      { coluna: "sent_by_user_id", op: "eq", valor: "u1" },
    ]);
  });

  test("só departamento gera só a condição de departamento", () => {
    expect(paresDeFiltro({ departmentId: "d1", userId: null }, "atendimento")).toEqual([
      { coluna: "current_department_id", op: "eq", valor: "d1" },
    ]);
  });

  test("'sem departamento' vira IS NULL, não igualdade com a sentinela", () => {
    expect(paresDeFiltro({ departmentId: SEM_DEPARTAMENTO, userId: null }, "atendimento")).toEqual([
      { coluna: "current_department_id", op: "is", valor: null },
    ]);
    expect(paresDeFiltro({ departmentId: SEM_DEPARTAMENTO, userId: null }, "mensagem")).toEqual([
      { coluna: "department_id", op: "is", valor: null },
    ]);
  });
});

describe("SEM_DEPARTAMENTO", () => {
  test("é a sentinela que o RPC entende como sem departamento", () => {
    expect(SEM_DEPARTAMENTO).toBe("00000000-0000-0000-0000-000000000000");
  });

  test("passa pelo select como um id normal", () => {
    expect(filtroDeSelect(SEM_DEPARTAMENTO)).toBe(SEM_DEPARTAMENTO);
  });
});
