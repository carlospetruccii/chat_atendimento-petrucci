// Testes do parse do JID da instância conectada (o "nosso número").
// Rodar: deno test supabase/functions/_shared/uazapi-instancia.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { numeroDoJidInstancia } from "./uazapi-client.ts";

Deno.test("numeroDoJidInstancia: string com sufixo de dispositivo (formato real)", () => {
  // Formato que a instância devolve de verdade em GET /instance/status.
  assertEquals(numeroDoJidInstancia("5519991351061:7@s.whatsapp.net"), "5519991351061");
});

Deno.test("numeroDoJidInstancia: string sem sufixo de dispositivo", () => {
  assertEquals(numeroDoJidInstancia("5519991351061@s.whatsapp.net"), "5519991351061");
});

Deno.test("numeroDoJidInstancia: dígitos puros (instance.owner)", () => {
  assertEquals(numeroDoJidInstancia("5519991351061"), "5519991351061");
});

Deno.test("numeroDoJidInstancia: formato objeto { user } (o que a doc sugere)", () => {
  assertEquals(numeroDoJidInstancia({ user: "5519991351061" }), "5519991351061");
});

Deno.test("numeroDoJidInstancia: ausente ou inutilizável devolve undefined", () => {
  assertEquals(numeroDoJidInstancia(undefined), undefined);
  assertEquals(numeroDoJidInstancia(null), undefined);
  assertEquals(numeroDoJidInstancia(""), undefined);
  assertEquals(numeroDoJidInstancia("@s.whatsapp.net"), undefined);
  assertEquals(numeroDoJidInstancia({}), undefined);
  assertEquals(numeroDoJidInstancia({ user: "" }), undefined);
});
