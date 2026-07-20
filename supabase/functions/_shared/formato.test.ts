// Testes unitários dos helpers puros de formato.
// Rodar: deno test supabase/functions/_shared/formato.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatarEspera, interpolar, montarMensagem } from "./formato.ts";

Deno.test("formatarEspera: menos de 1h mostra minutos", () => {
  assertEquals(formatarEspera(0), "0 min");
  assertEquals(formatarEspera(45), "45 min");
  assertEquals(formatarEspera(59), "59 min");
});

Deno.test("formatarEspera: horas cheias sem minutos", () => {
  assertEquals(formatarEspera(60), "1h");
  assertEquals(formatarEspera(120), "2h");
});

Deno.test("formatarEspera: horas + minutos com zero à esquerda", () => {
  assertEquals(formatarEspera(90), "1h30");
  assertEquals(formatarEspera(65), "1h05");
  assertEquals(formatarEspera(125), "2h05");
});

Deno.test("interpolar: substitui chaves conhecidas", () => {
  const out = interpolar("Olá {{nome}}, setor {{dep}}", { nome: "Ana", dep: "Fiscal" });
  assertEquals(out, "Olá Ana, setor Fiscal");
});

Deno.test("interpolar: chave ausente vira string vazia (não deixa {{}} no texto)", () => {
  assertEquals(interpolar("x {{faltando}} y", {}), "x  y");
});

Deno.test("montarMensagem: completa (com dept, ator, observação e url)", () => {
  const msg = montarMensagem({
    clienteNome: "João Silva",
    departamentoNome: "Fiscal",
    atorNome: "Leticia",
    observacao: "cliente urgente",
    appUrl: "https://app.exemplo.com",
  });
  assertEquals(
    msg,
    "🔔 Novo atendimento pra você\n\n" +
      "*João Silva* foi repassado(a) pra você por Leticia.\n" +
      "🏷️ Fiscal\n" +
      "📝 cliente urgente\n\n" +
      "Abra o painel para atender: https://app.exemplo.com",
  );
});

Deno.test("montarMensagem: mínima (sem ator, dept, observação nem url)", () => {
  const msg = montarMensagem({
    clienteNome: "Cliente",
    departamentoNome: null,
    atorNome: null,
    observacao: null,
    appUrl: null,
  });
  assertEquals(
    msg,
    "🔔 Novo atendimento pra você\n\n" +
      "*Cliente* foi repassado(a) pra você.\n\n" +
      "Abra o painel para atender.",
  );
});

Deno.test("montarMensagem: sem ator não inclui ' por ...'", () => {
  const msg = montarMensagem({
    clienteNome: "X",
    departamentoNome: null,
    atorNome: null,
    observacao: null,
    appUrl: null,
  });
  // Não deve conter " por " na linha do repasse.
  assertEquals(msg.includes(" por "), false);
});
