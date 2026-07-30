// Testes da leitura de data/tipo do Message da uazapi.
// Rodar: deno test supabase/functions/_shared/mensagem-uazapi.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dataDaMensagem, parseMensagem } from "./mensagem-uazapi.ts";

Deno.test("dataDaMensagem: aceita milissegundos", () => {
  assertEquals(
    dataDaMensagem({ messageTimestamp: 1753970400000 }),
    new Date(1753970400000).toISOString(),
  );
});

Deno.test("dataDaMensagem: aceita segundos (converte para ms)", () => {
  assertEquals(
    dataDaMensagem({ messageTimestamp: 1753970400 }),
    new Date(1753970400000).toISOString(),
  );
});

Deno.test("dataDaMensagem: aceita string numérica", () => {
  assertEquals(
    dataDaMensagem({ messageTimestamp: "1753970400" }),
    new Date(1753970400000).toISOString(),
  );
});

Deno.test("dataDaMensagem: sem timestamp devolve null (cai no default do banco)", () => {
  assertEquals(dataDaMensagem({}), null);
  assertEquals(dataDaMensagem({ messageTimestamp: 0 }), null);
  assertEquals(dataDaMensagem({ messageTimestamp: "abacaxi" }), null);
});

Deno.test("dataDaMensagem: data absurda é rejeitada", () => {
  // 1970 em ms → ano 1970, fora da faixa aceita.
  assertEquals(dataDaMensagem({ messageTimestamp: 1000 }), null);
});

Deno.test("parseMensagem: documento traz nome do arquivo e mime", () => {
  const r = parseMensagem({
    messageType: "document",
    text: "segue o balanço",
    content: { mimetype: "application/pdf", fileName: "balanco.pdf" },
  });
  assertEquals(r?.tipo, "documento");
  assertEquals(r?.content, "segue o balanço");
  assertEquals(r?.media_metadata, { mime_type: "application/pdf", file_name: "balanco.pdf" });
});

Deno.test("parseMensagem: mídia sem fileURL fica com placeholder de download", () => {
  const r = parseMensagem({ messageType: "image", content: { mimetype: "image/jpeg" } });
  assertEquals(r?.media_url, "pending:uazapi");
});
