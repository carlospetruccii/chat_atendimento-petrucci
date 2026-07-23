// Testes unitários da lógica pura de troca de papel.
// Rodar: deno test supabase/functions/alterar-papel-colaborador/logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { EntradaTroca, resolverTrocaPapel } from "./logic.ts";

const base: EntradaTroca = {
  callerRole: "dono",
  callerId: "dono-1",
  targetId: "colab-1",
  targetExists: true,
  targetRole: "colaborador",
  novoRole: "administrador",
  departmentId: null,
};

Deno.test("promove colaborador → administrador (sem departamento)", () => {
  const r = resolverTrocaPapel({ ...base, novoRole: "administrador" });
  assertEquals(r, { ok: true, isAdmin: true, departmentId: null });
});

Deno.test("promove colaborador → administrador com departamento atribuído (opcional)", () => {
  // Admin pode ter um departamento marcado — continua vendo tudo, mas passa a
  // receber os avisos de novo pendente daquele setor.
  const r = resolverTrocaPapel({ ...base, novoRole: "administrador", departmentId: "dept-outros" });
  assertEquals(r, { ok: true, isAdmin: true, departmentId: "dept-outros" });
});

Deno.test("rebaixa administrador → colaborador com departamento", () => {
  const r = resolverTrocaPapel({
    ...base,
    targetRole: "administrador",
    novoRole: "colaborador",
    departmentId: "dept-9",
  });
  assertEquals(r, { ok: true, isAdmin: false, departmentId: "dept-9" });
});

Deno.test("colaborador sem departamento é rejeitado", () => {
  const r = resolverTrocaPapel({
    ...base,
    targetRole: "administrador",
    novoRole: "colaborador",
    departmentId: "   ",
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test("só o dono pode trocar papéis", () => {
  const r = resolverTrocaPapel({ ...base, callerRole: "administrador" });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 403);
});

Deno.test("não pode alterar o próprio papel", () => {
  const r = resolverTrocaPapel({ ...base, targetId: "dono-1" });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test("não pode alterar o papel de outro dono", () => {
  const r = resolverTrocaPapel({ ...base, targetRole: "dono" });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test("papel inválido é rejeitado", () => {
  const r = resolverTrocaPapel({ ...base, novoRole: "chefe" });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test("alvo inexistente retorna 404", () => {
  const r = resolverTrocaPapel({ ...base, targetExists: false, targetRole: null });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 404);
});
