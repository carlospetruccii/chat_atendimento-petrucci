// Rodar: deno test supabase/functions/_shared/docs-rastreio.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  chatIndividualValido,
  classificarEcoDocs,
  TRACK_SOURCE_DOCS,
  urlMidiaConfiavel,
} from "./docs-rastreio.ts";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

Deno.test("eco com a nossa marca e id válido: é nosso, com o id da linha", () => {
  assertEquals(classificarEcoDocs({ track_source: TRACK_SOURCE_DOCS, track_id: ID }), {
    tipo: "nosso",
    mensagemId: ID,
  });
});

Deno.test("eco marcado por outro sistema (ou marca vazia): não é nosso", () => {
  assertEquals(classificarEcoDocs({ track_source: "", track_id: "" }), { tipo: "outro" });
  assertEquals(classificarEcoDocs({ track_source: "sistema-financeiro", track_id: ID }), {
    tipo: "outro",
  });
});

Deno.test("nossa marca com id torto não vira adoção às cegas", () => {
  assertEquals(classificarEcoDocs({ track_source: TRACK_SOURCE_DOCS, track_id: "x" }), {
    tipo: "outro",
  });
});

Deno.test("payload sem os campos de rastreio: a uazapi não informa, cai na heurística", () => {
  assertEquals(classificarEcoDocs({ id: "owner:1" }), { tipo: "sem_rastreio" });
});

Deno.test("só conversa individual entra no Docs", () => {
  assertEquals(chatIndividualValido("5511999998888@s.whatsapp.net"), true);
  assertEquals(chatIndividualValido("5511999998888@c.us"), true);
  assertEquals(chatIndividualValido("123456789012345@lid"), true);
  assertEquals(chatIndividualValido("status@broadcast"), false);
  assertEquals(chatIndividualValido("120363012345678901@newsletter"), false);
  assertEquals(chatIndividualValido("120363012345678901@g.us"), false);
  assertEquals(chatIndividualValido(undefined), false);
});

Deno.test("URL de mídia do payload só se for https do WhatsApp", () => {
  assertEquals(urlMidiaConfiavel("https://mmg.whatsapp.net/v/t62/abc.enc"), "https://mmg.whatsapp.net/v/t62/abc.enc");
  assertEquals(urlMidiaConfiavel("http://mmg.whatsapp.net/x"), null);
  assertEquals(urlMidiaConfiavel("https://evil.com/?h=whatsapp.net"), null);
  assertEquals(urlMidiaConfiavel("https://whatsapp.net.evil.com/x"), null);
  assertEquals(urlMidiaConfiavel("https://[::ffff:a9fe:a9fe]/x"), null);
  assertEquals(urlMidiaConfiavel(null), null);
});
