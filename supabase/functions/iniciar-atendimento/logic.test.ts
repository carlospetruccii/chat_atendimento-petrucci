// Testes unitários da escolha de setor de quem inicia a conversa para si.
// Rodar: deno test supabase/functions/iniciar-atendimento/logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { escolherDepartamentoProprio } from "./logic.ts";

Deno.test("sem pedido: usa o principal", () => {
  assertEquals(
    escolherDepartamentoProprio({ principal: "vendas", meus: ["vendas", "sem-parar"], pedido: null }),
    { ok: true, departmentId: "vendas" },
  );
});

Deno.test("pedido entre os setores da pessoa: usa o pedido", () => {
  assertEquals(
    escolherDepartamentoProprio({ principal: "vendas", meus: ["vendas", "sem-parar"], pedido: "sem-parar" }),
    { ok: true, departmentId: "sem-parar" },
  );
});

Deno.test("pedido fora dos setores da pessoa: recusa", () => {
  assertEquals(
    escolherDepartamentoProprio({ principal: "vendas", meus: ["vendas"], pedido: "financeiro" }),
    { ok: false, erro: "departamento_invalido" },
  );
});

Deno.test("sem nenhum setor: recusa", () => {
  assertEquals(
    escolherDepartamentoProprio({ principal: null, meus: [], pedido: null }),
    { ok: false, erro: "caller_sem_departamento" },
  );
});
