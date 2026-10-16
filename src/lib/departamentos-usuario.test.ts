import { describe, expect, test } from "vitest";
import {
  agruparPorDepartamento,
  departamentosPorUsuario,
  mesmosDepartamentos,
  SEM_DEPARTAMENTO_NOME,
} from "./departamentos-usuario";

const vendas = { nome: "Vendas", cor: "#111111" };
const semParar = { nome: "Sem Parar", cor: "#222222" };
const suporte = { nome: "Suporte", cor: "#333333" };

describe("departamentosPorUsuario", () => {
  test("principal vem primeiro, os demais por nome", () => {
    const mapa = departamentosPorUsuario(
      [
        { user_id: "luiz", department_id: "d-suporte", departments: suporte },
        { user_id: "luiz", department_id: "d-vendas", departments: vendas },
        { user_id: "luiz", department_id: "d-sem-parar", departments: semParar },
      ],
      new Map([["luiz", "d-vendas"]]),
    );
    expect(mapa.get("luiz")?.map((d) => d.nome)).toEqual(["Vendas", "Sem Parar", "Suporte"]);
  });

  test("setor sem nome legível cai no fallback e pessoa sem vínculo não aparece", () => {
    const mapa = departamentosPorUsuario(
      [{ user_id: "ana", department_id: "d-x", departments: null }],
      new Map(),
    );
    expect(mapa.get("ana")).toEqual([{ id: "d-x", nome: "—", cor: "#64748b" }]);
    expect(mapa.has("bia")).toBe(false);
  });
});

describe("agruparPorDepartamento", () => {
  const pessoas = [
    {
      id: "luiz",
      nome: "Luiz",
      departamentos: [
        { id: "d-vendas", nome: "Vendas" },
        { id: "d-sem-parar", nome: "Sem Parar" },
      ],
    },
    { id: "ana", nome: "Ana", departamentos: [{ id: "d-vendas", nome: "Vendas" }] },
    { id: "chefe", nome: "Chefe", departamentos: [] },
  ];

  test("quem tem vários setores aparece em cada um deles", () => {
    const grupos = agruparPorDepartamento(pessoas, "");
    expect(grupos.map((g) => [g.nome, g.pessoas.map((p) => p.id)])).toEqual([
      ["Vendas", ["luiz", "ana"]],
      ["Sem Parar", ["luiz"]],
      [SEM_DEPARTAMENTO_NOME, ["chefe"]],
    ]);
    expect(grupos[0].departmentId).toBe("d-vendas");
    expect(grupos[2].departmentId).toBeNull();
  });

  test("busca filtra por nome sem diferenciar maiúsculas", () => {
    const grupos = agruparPorDepartamento(pessoas, "LUI");
    expect(grupos.map((g) => [g.nome, g.pessoas.map((p) => p.id)])).toEqual([
      ["Vendas", ["luiz"]],
      ["Sem Parar", ["luiz"]],
    ]);
  });
});

describe("mesmosDepartamentos", () => {
  test("compara ordem também (o 1º é o principal)", () => {
    expect(mesmosDepartamentos(["a", "b"], ["a", "b"])).toBe(true);
    expect(mesmosDepartamentos(["a", "b"], ["b", "a"])).toBe(false);
    expect(mesmosDepartamentos(["a"], ["a", "b"])).toBe(false);
    expect(mesmosDepartamentos([], [])).toBe(true);
  });
});
