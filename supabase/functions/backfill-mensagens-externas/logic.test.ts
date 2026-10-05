// Testes das decisões puras do backfill.
// Rodar: deno test supabase/functions/backfill-mensagens-externas/logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  idsPossiveis,
  inteiroNoIntervalo,
  papelDaMensagemBackfill,
  usaJanelaDuplicata,
} from "./logic.ts";

Deno.test("idsPossiveis: monta o formato owner:messageid que o webhook grava", () => {
  const r = idsPossiveis({ owner: "5519991351061", messageid: "3EB0FC59", id: "r3EB0538" });
  assertEquals(r.preferido, "5519991351061:3EB0FC59");
  assertEquals(r.todos.sort(), ["3EB0FC59", "5519991351061:3EB0FC59", "r3EB0538"]);
});

Deno.test("idsPossiveis: sem owner, prefere o id já composto", () => {
  const r = idsPossiveis({ id: "5519991351061:3EB0FC59", messageid: "3EB0FC59" });
  assertEquals(r.preferido, "5519991351061:3EB0FC59");
});

Deno.test("idsPossiveis: só messageid ainda serve de chave", () => {
  assertEquals(idsPossiveis({ messageid: "3EB0FC59" }).preferido, "3EB0FC59");
});

Deno.test("idsPossiveis: mensagem sem identificador nenhum é descartável", () => {
  const r = idsPossiveis({ text: "oi" });
  assertEquals(r.preferido, null);
  assertEquals(r.todos, []);
});

Deno.test("inteiroNoIntervalo: usa o padrão quando o valor não é número", () => {
  assertEquals(inteiroNoIntervalo(undefined, 7, 1, 90), 7);
  assertEquals(inteiroNoIntervalo("abacaxi", 7, 1, 90), 7);
});

Deno.test("inteiroNoIntervalo: prende nos limites", () => {
  assertEquals(inteiroNoIntervalo(500, 7, 1, 90), 90);
  assertEquals(inteiroNoIntervalo(-3, 7, 1, 90), 1);
  assertEquals(inteiroNoIntervalo(14.9, 7, 1, 90), 14);
});

Deno.test("papelDaMensagemBackfill: fromMe é a mensagem que o outro sistema enviou", () => {
  assertEquals(papelDaMensagemBackfill(true), {
    direction: "outbound",
    sender_type: "externo",
    status_whatsapp: "enviado",
  });
});

Deno.test("papelDaMensagemBackfill: recebida entra como o webhook grava — cliente/inbound", () => {
  // Espelha o insert de inbound do webhook-zapi-receive (status_whatsapp null:
  // status de entrega só existe para o que NÓS enviamos).
  assertEquals(papelDaMensagemBackfill(false), {
    direction: "inbound",
    sender_type: "cliente",
    status_whatsapp: null,
  });
});

Deno.test("usaJanelaDuplicata: outbound usa a rede extra por janela de tempo", () => {
  assertEquals(usaJanelaDuplicata("outbound"), true);
});

Deno.test("usaJanelaDuplicata: inbound NÃO usa — rajada do cliente não é duplicata", () => {
  // Caso real: o cliente mandou "bom dia, tudo e vc?" 13:08:13 e "estou
  // aguardando o Pedro" 13:08:33. A janela de 60s tratava a segunda como cópia
  // da primeira e a descartava. Para inbound o zapi_message_id já basta.
  assertEquals(usaJanelaDuplicata("inbound"), false);
});
