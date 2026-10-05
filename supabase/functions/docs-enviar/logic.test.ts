// Rodar: deno test supabase/functions/docs-enviar/logic.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { podeEscrever, validarEnvioDocs } from "./logic.ts";

const CONVERSA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const EU = "cccccccc-cccc-cccc-cccc-cccccccccccc";

Deno.test("texto válido vira envio com conversaId", () => {
  const r = validarEnvioDocs({ conversa_id: CONVERSA, tipo: "texto", content: " oi " });
  assert(r.ok);
  assertEquals(r.envio.conversaId, CONVERSA);
  assertEquals(r.envio.content, "oi");
  assertEquals("grupoId" in r.envio, false);
});

Deno.test("sem conversa_id o erro fala de conversa, não de grupo", () => {
  const r = validarEnvioDocs({ tipo: "texto", content: "oi" });
  assert(!r.ok);
  assertEquals(r.erro, "conversa_id_obrigatorio");
  assertEquals(r.status, 400);
});

Deno.test("mídia sem arquivo continua rejeitada (mesma regra de grupo)", () => {
  const r = validarEnvioDocs({ conversa_id: CONVERSA, tipo: "document" });
  assert(!r.ok);
  assertEquals(r.erro, "arquivo_obrigatorio");
});

Deno.test("ids tortos são pedido malformado (400), não erro do banco", () => {
  const r1 = validarEnvioDocs({ conversa_id: "x", tipo: "texto", content: "oi" });
  assert(!r1.ok);
  assertEquals(r1.erro, "conversa_id_invalido");
  assertEquals(r1.status, 400);
  const r2 = validarEnvioDocs({
    conversa_id: CONVERSA,
    tipo: "texto",
    content: "oi",
    reply_to_message_id: "nao-e-uuid",
  });
  assert(!r2.ok);
  assertEquals(r2.erro, "reply_invalido");
});

Deno.test("só o dono de conversa em andamento escreve", () => {
  assert(podeEscrever({ status: "em_andamento", assigned_to: EU }, EU));
  assert(!podeEscrever({ status: "em_andamento", assigned_to: "outro" }, EU));
  assert(!podeEscrever({ status: "sem_dono", assigned_to: null }, EU));
  assert(!podeEscrever({ status: "encerrada", assigned_to: null }, EU));
  assert(!podeEscrever({ status: "so_envio", assigned_to: null }, EU));
});
