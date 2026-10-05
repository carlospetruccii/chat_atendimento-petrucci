// Rodar: deno test supabase/functions/docs-importar-historico/logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extrairChats, paraMs, validarPedidoImportacao } from "./logic.ts";

Deno.test("timestamp da uazapi em segundos ou milissegundos vira ms", () => {
  assertEquals(paraMs(1790000000), 1790000000000);
  assertEquals(paraMs(1790000000123), 1790000000123);
  assertEquals(paraMs("1790000000"), 1790000000000);
  assertEquals(paraMs(null), null);
  assertEquals(paraMs("abc"), null);
});

Deno.test("chats: aceita envelope { chats } e array cru; só conversa individual", () => {
  const r = extrairChats({
    chats: [
      { wa_chatid: "5511999998888@s.whatsapp.net", wa_lastMsgTimestamp: 1790000000000, wa_name: "Ana" },
      { wa_chatid: "120363012345678901@g.us", wa_lastMsgTimestamp: 1790000000000 },
      { wa_chatid: "status@broadcast", wa_lastMsgTimestamp: 1790000000000 },
      { wa_lastMsgTimestamp: 1 },
    ],
  });
  assertEquals(r, [{ chatid: "5511999998888@s.whatsapp.net", ultimaMs: 1790000000000 }]);
  assertEquals(extrairChats([{ wa_chatid: "551188887777@s.whatsapp.net", wa_lastMsgTimestamp: 1790000000 }]), [
    { chatid: "551188887777@s.whatsapp.net", ultimaMs: 1790000000000 },
  ]);
  assertEquals(extrairChats(null), []);
});

Deno.test("pedido: padrão é simulação de 7 dias em lotes pequenos", () => {
  assertEquals(validarPedidoImportacao({}), { dias: 7, limiteChats: 30, offset: 0, dryRun: true });
});

Deno.test("pedido: limites seguros (a uazapi só guarda ~7 dias)", () => {
  assertEquals(
    validarPedidoImportacao({ dias: 30, limite_chats: 999, offset: -5, dry_run: false }),
    { dias: 10, limiteChats: 100, offset: 0, dryRun: false },
  );
  assertEquals(validarPedidoImportacao({ dias: 2, limite_chats: 10, offset: 40, dry_run: "false" }), {
    dias: 2,
    limiteChats: 10,
    offset: 40,
    dryRun: true,
  });
});
