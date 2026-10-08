// Testes unitários da lógica pura do bot de triagem.
// Rodar: deno test supabase/functions/triagem-bot/logic.test.ts

// deno-lint-ignore no-import-prefix -- mantém o mesmo std fixado dos testes existentes.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { identificarPorTexto, LIST_TITULO, ordenarDepartamentos } from "./logic.ts";

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

// ===== identificarPorTexto — casos trazidos do Almore (926c795) =====


const ITENS = [
  { id: "contabil", nome: "Contábil" },
  { id: "fiscal", nome: "Fiscal" },
  { id: "pessoal", nome: "Departamento Pessoal" },
];

Deno.test("identificarPorTexto: aceita índice, nome e frase natural", () => {
  assertEquals(identificarPorTexto("2", ITENS), "fiscal");
  assertEquals(identificarPorTexto("opção 2", ITENS), "fiscal");
  assertEquals(identificarPorTexto("Contábil", ITENS), "contabil");
  assertEquals(
    identificarPorTexto("Quero falar com o setor contábil, por favor 😊", ITENS),
    "contabil",
  );
  assertEquals(identificarPorTexto("Preciso do Departamento Pessoal", ITENS), "pessoal");
});

Deno.test("identificarPorTexto: não escolhe quando a resposta é vazia ou ambígua", () => {
  assertEquals(identificarPorTexto("", ITENS), null);
  assertEquals(identificarPorTexto("fiscal ou contábil", ITENS), null);
  assertEquals(identificarPorTexto("contábil", []), null);
});

Deno.test("identificarPorTexto: ignora nomes e números encontrados dentro de e-mail ou URL", () => {
  assertEquals(identificarPorTexto("usuario@almorecontabilidade.com.br", ITENS), null);
  assertEquals(
    identificarPorTexto("https://inteligencia.almorecontabilidade.com.br/dashboard", ITENS),
    null,
  );
  assertEquals(identificarPorTexto("contabil@empresa.com", ITENS), null);
  assertEquals(identificarPorTexto("https://empresa.com/contabil", ITENS), null);
  assertEquals(identificarPorTexto("meu login é user2@empresa.com", ITENS), null);
  assertEquals(identificarPorTexto("acesse https://empresa.com/2", ITENS), null);
  assertEquals(identificarPorTexto("acesse empresa.com/contabil", ITENS), null);
  assertEquals(identificarPorTexto("acesse empresa.com/2", ITENS), null);
  assertEquals(identificarPorTexto("ftp://empresa.com/fiscal", ITENS), null);
  assertEquals(identificarPorTexto('"contabil"@empresa.com', ITENS), null);
  assertEquals(identificarPorTexto("é@contabil.com", ITENS), null);
  assertEquals(identificarPorTexto("user@contabil.中国", ITENS), null);
  assertEquals(identificarPorTexto("user@conta\u0301bil.com", ITENS), null);
  assertEquals(identificarPorTexto("h\u200Bttps://empresa.com/fiscal", ITENS), null);
  assertEquals(identificarPorTexto("contabil\u200B.com", ITENS), null);
  assertEquals(identificarPorTexto("contabil.\u200Bcom", ITENS), null);
  assertEquals(identificarPorTexto("contabil。com", ITENS), null);
  assertEquals(identificarPorTexto("data:,fiscal", ITENS), null);
  assertEquals(identificarPorTexto("urn:empresa:fiscal", ITENS), null);
  assertEquals(identificarPorTexto("C:\\empresa\\fiscal", ITENS), null);
  assertEquals(identificarPorTexto("https:∕∕empresa。com∕fiscal", ITENS), null);
  assertEquals(identificarPorTexto("(data:,fiscal)", ITENS), null);
  assertEquals(identificarPorTexto("[data:,fiscal]", ITENS), null);
  assertEquals(identificarPorTexto('"urn:empresa:fiscal"', ITENS), null);
  assertEquals(identificarPorTexto("veja(data:,fiscal)", ITENS), null);
  assertEquals(identificarPorTexto("<data:,fiscal>", ITENS), null);
});

Deno.test("identificarPorTexto: exige palavras inteiras para identificar um item", () => {
  assertEquals(identificarPorTexto("contabilidade", ITENS), null);
  assertEquals(identificarPorTexto("fiscalização", ITENS), null);
});

Deno.test("identificarPorTexto: mantém sinais de itens diferentes como resposta ambígua", () => {
  assertEquals(identificarPorTexto("contábil ou pessoal", ITENS), null);
  assertEquals(identificarPorTexto("fiscal ou 1", ITENS), null);
  assertEquals(identificarPorTexto("fiscal ou 1 ou 3", ITENS), null);
  assertEquals(identificarPorTexto("fiscal 1 99", ITENS), null);
  assertEquals(
    identificarPorTexto("Ana", [
      { id: "ana-1", nome: "Ana" },
      { id: "ana-2", nome: "Ana" },
    ]),
    null,
  );
});

Deno.test("identificarPorTexto: número em texto comum não vira opção do menu", () => {
  assertEquals(identificarPorTexto("meu código é 2", ITENS), null);
  assertEquals(identificarPorTexto("protocolo 2", ITENS), null);
  assertEquals(identificarPorTexto("R$ 2", ITENS), null);
  assertEquals(identificarPorTexto("às 2", ITENS), null);
  assertEquals(identificarPorTexto("ID 2", ITENS), null);
  assertEquals(identificarPorTexto("-2", ITENS), null);
  assertEquals(identificarPorTexto("+2", ITENS), null);
  assertEquals(identificarPorTexto("setor -2", ITENS), null);
  assertEquals(identificarPorTexto("setor +2", ITENS), null);
  assertEquals(identificarPorTexto("departamento -2", ITENS), null);
  assertEquals(identificarPorTexto("opção −2", ITENS), null);
  assertEquals(identificarPorTexto("setor $2", ITENS), null);
  assertEquals(identificarPorTexto("departamento €2", ITENS), null);
  assertEquals(identificarPorTexto("setor 2%", ITENS), null);
  assertEquals(identificarPorTexto("opção .2", ITENS), null);
  assertEquals(identificarPorTexto("opção ,2", ITENS), null);
});

Deno.test("identificarPorTexto: aceita frases naturais que escolhem um índice", () => {
  assertEquals(identificarPorTexto("pode ser 2", ITENS), "fiscal");
  assertEquals(identificarPorTexto("escolho 2", ITENS), "fiscal");
  assertEquals(identificarPorTexto("fico com a 2", ITENS), "fiscal");
  assertEquals(identificarPorTexto("a opção é 2", ITENS), "fiscal");
  assertEquals(identificarPorTexto("eu escolho 2", ITENS), "fiscal");
  assertEquals(identificarPorTexto("opção 2, por favor", ITENS), "fiscal");
  assertEquals(identificarPorTexto("gostaria da opção 2", ITENS), "fiscal");
  assertEquals(identificarPorTexto("opção de número 2", ITENS), "fiscal");
  assertEquals(identificarPorTexto("setor 2", ITENS), "fiscal");
  assertEquals(identificarPorTexto("quero o setor 2", ITENS), "fiscal");
  assertEquals(identificarPorTexto("departamento 2", ITENS), "fiscal");
  assertEquals(identificarPorTexto("2.", ITENS), "fiscal");
  assertEquals(identificarPorTexto("2!", ITENS), "fiscal");
  assertEquals(identificarPorTexto("2,", ITENS), "fiscal");
  assertEquals(identificarPorTexto("opção 2 😊", ITENS), "fiscal");
  assertEquals(identificarPorTexto("quero o setor 2 ✅", ITENS), "fiscal");
  assertEquals(identificarPorTexto("opção 2 — por favor", ITENS), "fiscal");
});

Deno.test("identificarPorTexto: entrada grande falha de forma segura", () => {
  assertEquals(identificarPorTexto(`${"a".repeat(4_097)} contabil`, ITENS), null);
});

// ===== identificarPorTexto — menu da Parabrisas Petrucci =====

const MENU_PETRUCCI = [
  { id: "vendas", nome: "Vendas" },
  { id: "suporte", nome: "Suporte" },
  { id: "financeiro", nome: "Financeiro" },
  { id: "sem-parar", nome: "Sem parar" },
];

Deno.test("identificarPorTexto (Petrucci): número, nome e frase", () => {
  assertEquals(identificarPorTexto("1", MENU_PETRUCCI), "vendas");
  assertEquals(identificarPorTexto("4", MENU_PETRUCCI), "sem-parar");
  assertEquals(identificarPorTexto("Sem parar", MENU_PETRUCCI), "sem-parar");
  assertEquals(identificarPorTexto("quero instalar a tag sem parar", MENU_PETRUCCI), "sem-parar");
  assertEquals(identificarPorTexto("quero falar com o financeiro", MENU_PETRUCCI), "financeiro");
});

Deno.test("identificarPorTexto (Petrucci): singular e plural casam", () => {
  assertEquals(identificarPorTexto("venda", MENU_PETRUCCI), "vendas");
  assertEquals(identificarPorTexto("é sobre uma venda", MENU_PETRUCCI), "vendas");
});

Deno.test("identificarPorTexto (Petrucci): 'sem' solto não manda para Sem parar", () => {
  assertEquals(identificarPorTexto("estou sem vidro, quero orçamento", MENU_PETRUCCI), null);
  assertEquals(identificarPorTexto("sem", MENU_PETRUCCI), null);
});

Deno.test("identificarPorTexto (Petrucci): e-mail e link com nome de setor não roteiam", () => {
  assertEquals(identificarPorTexto("vendas@parabrisaspetrucci.com.br", MENU_PETRUCCI), null);
  assertEquals(identificarPorTexto("https://site.com/suporte", MENU_PETRUCCI), null);
});
