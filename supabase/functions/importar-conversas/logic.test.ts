// Testes das decisões puras da importação de conversas.
// Rodar: deno test supabase/functions/importar-conversas/logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { alvoDoChat, atendimentoDoMomento, nomeDoChat, tsParaMs } from "./logic.ts";

const SEM_EXCLUSAO = new Set<string>();

Deno.test("tsParaMs: aceita segundos, ms e string; rejeita lixo", () => {
  assertEquals(tsParaMs(1_700_000_000), 1_700_000_000_000);
  assertEquals(tsParaMs(1_700_000_000_000), 1_700_000_000_000);
  assertEquals(tsParaMs("1700000000"), 1_700_000_000_000);
  assertEquals(tsParaMs(0), null);
  assertEquals(tsParaMs("abc"), null);
  assertEquals(tsParaMs(undefined), null);
});

Deno.test("nomeDoChat: prefere nome salvo e ignora nome que é só telefone", () => {
  assertEquals(nomeDoChat({ wa_contactName: "Maria", wa_name: "Mari" }), "Maria");
  assertEquals(nomeDoChat({ wa_contactName: "+55 19 99999-8888", wa_name: "João" }), "João");
  assertEquals(nomeDoChat({ wa_contactName: "", name: "" }), null);
});

Deno.test("alvoDoChat: chat individual vira alvo com número E.164", () => {
  const r = alvoDoChat(
    {
      wa_chatid: "5519999998888@s.whatsapp.net",
      wa_chatlid: "123456@lid",
      wa_name: "Ana",
      imagePreview: "https://pps.whatsapp.net/a.jpg",
      wa_lastMsgTimestamp: 1_700_000_000_000,
    },
    SEM_EXCLUSAO,
  );
  assertEquals(r, {
    chatid: "5519999998888@s.whatsapp.net",
    numero: "+5519999998888",
    lid: "123456",
    nome: "Ana",
    foto: "https://pps.whatsapp.net/a.jpg",
    ultimaMsgMs: 1_700_000_000_000,
  });
});

Deno.test("alvoDoChat: chat @lid usa o campo phone como número", () => {
  const r = alvoDoChat({ wa_chatid: "98765@lid", phone: "+55 19 99999-8888" }, SEM_EXCLUSAO);
  assertEquals(r?.numero, "+5519999998888");
  assertEquals(r?.lid, "98765");
  assertEquals(r?.chatid, "98765@lid");
});

Deno.test("alvoDoChat: descarta grupo, status, canal e chat sem telefone", () => {
  assertEquals(alvoDoChat({ wa_chatid: "1203630@g.us" }, SEM_EXCLUSAO), null);
  assertEquals(alvoDoChat({ wa_chatid: "551999@s.whatsapp.net", wa_isGroup: true }, SEM_EXCLUSAO), null);
  assertEquals(alvoDoChat({ wa_chatid: "status@broadcast" }, SEM_EXCLUSAO), null);
  assertEquals(alvoDoChat({ wa_chatid: "1234@newsletter" }, SEM_EXCLUSAO), null);
  assertEquals(alvoDoChat({ wa_chatid: "98765@lid" }, SEM_EXCLUSAO), null);
  assertEquals(alvoDoChat({}, SEM_EXCLUSAO), null);
});

Deno.test("alvoDoChat: descarta número da lista de exclusão", () => {
  const excl = new Set(["5519982786429"]);
  assertEquals(alvoDoChat({ wa_chatid: "5519982786429@s.whatsapp.net" }, excl), null);
});

Deno.test("atendimentoDoMomento: pega o último criado até o instante", () => {
  const lista = [
    { id: "a", created_at: "2026-09-01T00:00:00Z", current_department_id: null },
    { id: "b", created_at: "2026-09-10T00:00:00Z", current_department_id: "d" },
  ];
  assertEquals(atendimentoDoMomento(lista, "2026-08-30T00:00:00Z"), null);
  assertEquals(atendimentoDoMomento(lista, "2026-09-01T00:00:00Z")?.id, "a");
  assertEquals(atendimentoDoMomento(lista, "2026-09-05T00:00:00Z")?.id, "a");
  assertEquals(atendimentoDoMomento(lista, "2026-09-20T00:00:00Z")?.id, "b");
  assertEquals(atendimentoDoMomento([], "2026-09-20T00:00:00Z"), null);
});
