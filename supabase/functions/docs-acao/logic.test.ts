// Rodar: deno test supabase/functions/docs-acao/logic.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ehDonoOuAdmin, validarPedidoAcao } from "./logic.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

Deno.test("apagar aceita de 1 a 10 ids válidos e remove repetidos", () => {
  const r = validarPedidoAcao({ acao: "apagar", mensagem_ids: [A, A, B] });
  assert(r.ok);
  assertEquals(r.pedido, { acao: "apagar", mensagemIds: [A, B] });
});

Deno.test("apagar recusa lista vazia, grande demais ou id torto", () => {
  assert(!validarPedidoAcao({ acao: "apagar", mensagem_ids: [] }).ok);
  assert(!validarPedidoAcao({ acao: "apagar", mensagem_ids: Array(11).fill(0).map((_, i) =>
    `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`
  ) }).ok);
  assert(!validarPedidoAcao({ acao: "apagar", mensagem_ids: ["x"] }).ok);
});

Deno.test("editar exige texto não vazio e no limite", () => {
  const ok = validarPedidoAcao({ acao: "editar", mensagem_id: A, texto: "  novo  " });
  assert(ok.ok);
  assertEquals(ok.pedido, { acao: "editar", mensagemId: A, texto: "novo" });
  assert(!validarPedidoAcao({ acao: "editar", mensagem_id: A, texto: "   " }).ok);
  assert(!validarPedidoAcao({ acao: "editar", mensagem_id: A, texto: "x".repeat(4097) }).ok);
});

Deno.test("encaminhar exige mensagem e conversa de destino", () => {
  const r = validarPedidoAcao({ acao: "encaminhar", mensagem_id: A, conversa_id_destino: B });
  assert(r.ok);
  assertEquals(r.pedido, { acao: "encaminhar", mensagemId: A, conversaIdDestino: B });
  assert(!validarPedidoAcao({ acao: "encaminhar", mensagem_id: A }).ok);
});

Deno.test("reprocessar mídia e marcar lido", () => {
  const r1 = validarPedidoAcao({ acao: "reprocessar_midia", mensagem_id: A });
  assert(r1.ok);
  assertEquals(r1.pedido, { acao: "reprocessar_midia", mensagemId: A });
  const r2 = validarPedidoAcao({ acao: "marcar_lido", conversa_id: B });
  assert(r2.ok);
  assertEquals(r2.pedido, { acao: "marcar_lido", conversaId: B });
});

Deno.test("ação desconhecida é recusada", () => {
  const r = validarPedidoAcao({ acao: "reagir" });
  assert(!r.ok);
  assertEquals(r.erro, "acao_invalida");
});

Deno.test("dono em andamento ou admin podem agir; resto não", () => {
  const EU = A;
  assert(ehDonoOuAdmin({ status: "em_andamento", assigned_to: EU }, EU, false));
  assert(ehDonoOuAdmin({ status: "sem_dono", assigned_to: null }, EU, true));
  assert(!ehDonoOuAdmin({ status: "em_andamento", assigned_to: B }, EU, false));
  assert(!ehDonoOuAdmin({ status: "sem_dono", assigned_to: null }, EU, false));
});
