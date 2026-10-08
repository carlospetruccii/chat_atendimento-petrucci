import { describe, expect, test } from "vitest";
import { moverDepartamento, type ItemOrdem } from "./departamentos-ordem";

const itens: ItemOrdem[] = [
  { id: "vendas", noMenu: true },
  { id: "suporte", noMenu: true },
  { id: "financeiro", noMenu: true },
  { id: "sem-parar", noMenu: true },
];

describe("moverDepartamento", () => {
  test("sobe o departamento uma posição", () => {
    expect(moverDepartamento(itens, "financeiro", "cima")).toEqual([
      "vendas",
      "financeiro",
      "suporte",
      "sem-parar",
    ]);
  });

  test("desce o departamento uma posição", () => {
    expect(moverDepartamento(itens, "vendas", "baixo")).toEqual([
      "suporte",
      "vendas",
      "financeiro",
      "sem-parar",
    ]);
  });

  test("devolve null quando o primeiro tenta subir", () => {
    expect(moverDepartamento(itens, "vendas", "cima")).toBeNull();
  });

  test("devolve null quando o último tenta descer", () => {
    expect(moverDepartamento(itens, "sem-parar", "baixo")).toBeNull();
  });

  test("devolve null quando o id não está na lista", () => {
    expect(moverDepartamento(itens, "outro", "cima")).toBeNull();
  });

  test("pula vizinho fora do menu e troca com o próximo que aparece no bot", () => {
    const comInativo: ItemOrdem[] = [
      { id: "vendas", noMenu: true },
      { id: "antigo", noMenu: false },
      { id: "suporte", noMenu: true },
    ];
    expect(moverDepartamento(comInativo, "suporte", "cima")).toEqual([
      "suporte",
      "antigo",
      "vendas",
    ]);
  });

  test("devolve null quando só há itens fora do menu na direção", () => {
    const comInativo: ItemOrdem[] = [
      { id: "antigo", noMenu: false },
      { id: "vendas", noMenu: true },
    ];
    expect(moverDepartamento(comInativo, "vendas", "cima")).toBeNull();
  });

  test("devolve null para item que não aparece no menu", () => {
    const comInativo: ItemOrdem[] = [
      { id: "vendas", noMenu: true },
      { id: "antigo", noMenu: false },
    ];
    expect(moverDepartamento(comInativo, "antigo", "cima")).toBeNull();
  });

  test("não altera a lista original", () => {
    const original = itens.map((i) => i.id);
    moverDepartamento(itens, "suporte", "baixo");
    expect(itens.map((i) => i.id)).toEqual(original);
  });
});
