import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  chatIdDaMensagem,
  chatIdDoNumero,
  dentroDaJanela,
  idsPossiveis,
  inteiroNoIntervalo,
  mensagensDoEventoHistory,
  messageidCru,
  numeroDoChatId,
} from "./historico.ts";

Deno.test("messageidCru tira o prefixo owner: da âncora", () => {
  assertEquals(messageidCru("5519991351061:3EB0ABC123"), "3EB0ABC123");
  assertEquals(messageidCru("3EB0ABC123"), "3EB0ABC123");
  assertEquals(messageidCru(null), null);
  assertEquals(messageidCru("   "), null);
  // Só o prefixo, sem messageid → não serve como âncora.
  assertEquals(messageidCru("5519991351061:"), null);
});

Deno.test("idsPossiveis cobre composto, id e messageid", () => {
  const r = idsPossiveis({ owner: "5519991351061", messageid: "3EB0", id: "algum:3EB0" });
  assertEquals(r.preferido, "5519991351061:3EB0");
  assertEquals(r.todos.sort(), ["3EB0", "5519991351061:3EB0", "algum:3EB0"].sort());
});

Deno.test("idsPossiveis sem nenhum id devolve nulo", () => {
  assertEquals(idsPossiveis({}).preferido, null);
  assertEquals(idsPossiveis({}).todos, []);
});

Deno.test("chatIdDoNumero e numeroDoChatId são inversos", () => {
  assertEquals(chatIdDoNumero("+55 (19) 99135-1061"), "5519991351061@s.whatsapp.net");
  assertEquals(numeroDoChatId("5519991351061@s.whatsapp.net"), "5519991351061");
  // Sufixo de dispositivo (":7") não pode virar parte do número.
  assertEquals(numeroDoChatId("5519991351061:7@s.whatsapp.net"), "5519991351061");
  assertEquals(chatIdDoNumero("abc"), null);
});

Deno.test("dentroDaJanela: teto exclusivo, piso inclusivo", () => {
  const desde = "2026-07-01T00:00:00.000Z";
  const ate = "2026-07-08T00:00:00.000Z";
  assertEquals(dentroDaJanela("2026-07-01T00:00:00.000Z", desde, ate), true);
  assertEquals(dentroDaJanela("2026-07-05T12:00:00.000Z", desde, ate), true);
  // A própria mensagem mais antiga que já temos não entra de novo.
  assertEquals(dentroDaJanela("2026-07-08T00:00:00.000Z", desde, ate), false);
  assertEquals(dentroDaJanela("2026-06-30T23:59:59.000Z", desde, ate), false);
  assertEquals(dentroDaJanela("nao-e-data", desde, ate), false);
});

Deno.test("inteiroNoIntervalo trunca e limita", () => {
  assertEquals(inteiroNoIntervalo(undefined, 30, 1, 90), 30);
  assertEquals(inteiroNoIntervalo(500, 30, 1, 90), 90);
  assertEquals(inteiroNoIntervalo(0, 30, 1, 90), 1);
  assertEquals(inteiroNoIntervalo("7", 30, 1, 90), 7);
  assertEquals(inteiroNoIntervalo("abc", 30, 1, 90), 30);
});

Deno.test("mensagensDoEventoHistory aceita array em messages", () => {
  const itens = mensagensDoEventoHistory({
    EventType: "history",
    messages: [{ messageType: "conversation", text: "oi" }, { messageType: "image" }],
  });
  assertEquals(itens.length, 2);
});

Deno.test("mensagensDoEventoHistory aceita mensagem única", () => {
  const itens = mensagensDoEventoHistory({
    EventType: "history",
    message: { messageType: "conversation", text: "oi" },
  });
  assertEquals(itens.length, 1);
  assertEquals(itens[0].text, "oi");
});

Deno.test("mensagensDoEventoHistory ignora envelope sem mensagem", () => {
  assertEquals(mensagensDoEventoHistory({ EventType: "history", token: "x" }), []);
});

Deno.test("chatIdDaMensagem cai para o chat do envelope", () => {
  assertEquals(
    chatIdDaMensagem({ text: "oi" }, { chat: { id: "5519991351061@s.whatsapp.net" } }),
    "5519991351061@s.whatsapp.net",
  );
  assertEquals(
    chatIdDaMensagem({ chatid: "551199@s.whatsapp.net" }, { chat: { id: "outro@s.whatsapp.net" } }),
    "551199@s.whatsapp.net",
  );
  assertEquals(chatIdDaMensagem({ text: "oi" }, {}), null);
});
