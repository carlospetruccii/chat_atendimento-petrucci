// Testes unitários da lógica pura do bot de triagem.
// Rodar: deno test supabase/functions/triagem-bot/logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { LIST_TITULO, ordenarDepartamentos } from "./logic.ts";

Deno.test("ordenarDepartamentos: segue a ordem cadastrada, não a alfabética", () => {
  const deps = [
    { id: "f", nome: "Financeiro", ordem: 3 },
    { id: "s", nome: "Sem parar", ordem: 4 },
    { id: "su", nome: "Suporte", ordem: 2 },
    { id: "v", nome: "Vendas", ordem: 1 },
  ];
  assertEquals(ordenarDepartamentos(deps).map((d) => d.nome), [
    "Vendas", "Suporte", "Financeiro", "Sem parar",
  ]);
});

Deno.test("ordenarDepartamentos: empate na ordem desempata pelo nome", () => {
  const deps = [
    { id: "b", nome: "Beta", ordem: 1 },
    { id: "a", nome: "Alfa", ordem: 1 },
  ];
  assertEquals(ordenarDepartamentos(deps).map((d) => d.nome), ["Alfa", "Beta"]);
});

Deno.test("ordenarDepartamentos: não altera a lista recebida", () => {
  const deps = [
    { id: "b", nome: "Beta", ordem: 2 },
    { id: "a", nome: "Alfa", ordem: 1 },
  ];
  ordenarDepartamentos(deps);
  assertEquals(deps.map((d) => d.id), ["b", "a"]);
});

Deno.test("LIST_TITULO: rodapé da lista mostra o nome da empresa", () => {
  assertEquals(LIST_TITULO, "Parabrisas Petrucci");
});
