// Rodar: deno test supabase/functions/webhook-docs-receive/logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classificarEvento,
  escolherNomeContato,
  mapStatusWhatsapp,
  origemExterna,
} from "./logic.ts";

Deno.test("mensagem do cliente (formato real: EventType + message)", () => {
  const e = classificarEvento({
    EventType: "messages",
    message: { id: "owner:1", chatid: "5511999998888@s.whatsapp.net", fromMe: false, text: "oi" },
  });
  assertEquals(e.rota, "mensagem");
  assertEquals(e.fromMe, false);
  assertEquals(e.messageId, "owner:1");
  assertEquals(e.ehGrupo, false);
});

Deno.test("documento do outro sistema: fromMe + wasSentByApi", () => {
  const e = classificarEvento({
    EventType: "messages",
    message: {
      id: "owner:2",
      chatid: "5511999998888@s.whatsapp.net",
      fromMe: true,
      wasSentByApi: true,
      messageType: "DocumentMessage",
    },
  });
  assertEquals(e.rota, "mensagem");
  assertEquals(e.fromMe, true);
  assertEquals(e.wasSentByApi, true);
});

Deno.test("status de entrega vai para a rota de status", () => {
  const e = classificarEvento({
    EventType: "messages_update",
    message: { id: "owner:3", status: "Delivered" },
  });
  assertEquals(e.rota, "status");
  assertEquals(e.statusRaw, "Delivered");
});

Deno.test("conexão é só log", () => {
  assertEquals(classificarEvento({ EventType: "connection" }).rota, "conexao");
});

Deno.test("grupo é marcado para ser ignorado no Docs", () => {
  const e = classificarEvento({
    EventType: "messages",
    message: { id: "owner:4", chatid: "120363012345678901@g.us", text: "oi" },
  });
  assertEquals(e.ehGrupo, true);
});

Deno.test("citação vem do campo quoted", () => {
  const e = classificarEvento({
    EventType: "messages",
    message: { id: "owner:5", chatid: "5511@s.whatsapp.net", text: "sim", quoted: "owner:1" },
  });
  assertEquals(e.quotedId, "owner:1");
});

Deno.test("origem externa é tri-estado (ausente não vira 'celular')", () => {
  assertEquals(origemExterna(true), "api_externa");
  assertEquals(origemExterna(false), "celular");
  assertEquals(origemExterna(undefined), "desconhecida");
});

Deno.test("nome do contato ignora vazio e telefone puro", () => {
  assertEquals(escolherNomeContato("", "  ", "+55 11 99999-8888", "Maria"), "Maria");
  assertEquals(escolherNomeContato(null, 123, undefined), null);
});

Deno.test("status da uazapi mapeia por substring", () => {
  assertEquals(mapStatusWhatsapp("Delivered"), "entregue");
  assertEquals(mapStatusWhatsapp("Read"), "lido");
  assertEquals(mapStatusWhatsapp("Played"), "lido");
  assertEquals(mapStatusWhatsapp("ServerAck"), null);
  assertEquals(mapStatusWhatsapp("Sent"), "enviado");
  assertEquals(mapStatusWhatsapp("Failed"), "falha_whatsapp");
});
