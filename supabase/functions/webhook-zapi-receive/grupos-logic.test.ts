// Testes da leitura de identidade de grupo nos payloads da uazapi.
// Rodar: deno test supabase/functions/webhook-zapi-receive/grupos-logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extrairIdentidadeGrupo,
  extrairNomeGrupo,
  normalizarJidGrupo,
} from "./grupos-logic.ts";

const JID = "120363012345678901@g.us";

Deno.test("mensagem de participante: extrai grupo, número e nome", () => {
  const id = extrairIdentidadeGrupo({
    chatid: JID,
    sender: "5511999998888@s.whatsapp.net",
    senderName: "Maria",
    fromMe: false,
  });
  assertEquals(id, {
    jid: JID,
    participanteNumero: "+5511999998888",
    participanteNome: "Maria",
    fromMe: false,
  });
});

Deno.test("sender_pn tem prioridade sobre sender", () => {
  const id = extrairIdentidadeGrupo({
    chatid: JID,
    sender_pn: "5511911112222",
    sender: "99887766554433@lid",
    senderName: "João",
  });
  assertEquals(id?.participanteNumero, "+5511911112222");
});

Deno.test("participante só com LID fica sem número (não cabe no E.164)", () => {
  const id = extrairIdentidadeGrupo({
    chatid: JID,
    sender: "99887766554433@lid",
    senderName: "Anônimo",
  });
  assertEquals(id?.participanteNumero, null);
  assertEquals(id?.participanteNome, "Anônimo");
});

Deno.test("fromMe: mensagem nossa, sem participante", () => {
  const id = extrairIdentidadeGrupo({
    chatid: JID,
    sender: "5511900000000@s.whatsapp.net",
    senderName: "Empresa",
    fromMe: true,
  });
  assertEquals(id, {
    jid: JID,
    participanteNumero: null,
    participanteNome: null,
    fromMe: true,
  });
});

Deno.test("chat individual não é grupo", () => {
  assertEquals(
    extrairIdentidadeGrupo({ chatid: "5511999998888@s.whatsapp.net", sender: "x" }),
    null,
  );
});

Deno.test("sem chatid não é grupo", () => {
  assertEquals(extrairIdentidadeGrupo({ sender: "5511999998888" }), null);
});

Deno.test("JID vem do envelope quando falta no payload", () => {
  const id = extrairIdentidadeGrupo(
    { sender: "5511999998888@s.whatsapp.net" },
    { chatid: JID },
  );
  assertEquals(id?.jid, JID);
});

Deno.test("nome puramente numérico é descartado (é o próprio telefone)", () => {
  const id = extrairIdentidadeGrupo({
    chatid: JID,
    sender: "5511999998888@s.whatsapp.net",
    senderName: "+55 11 99999-8888",
    pushName: "Zé da Obra",
  });
  assertEquals(id?.participanteNome, "Zé da Obra");
});

Deno.test("sem nenhum nome utilizável fica null", () => {
  const id = extrairIdentidadeGrupo({
    chatid: JID,
    sender: "5511999998888@s.whatsapp.net",
    senderName: "   ",
  });
  assertEquals(id?.participanteNome, null);
});

Deno.test("número curto ou começando com 0 não é E.164 válido", () => {
  assertEquals(
    extrairIdentidadeGrupo({ chatid: JID, sender: "1234@s.whatsapp.net" })?.participanteNumero,
    null,
  );
  assertEquals(
    extrairIdentidadeGrupo({ chatid: JID, sender: "05511999998888@s.whatsapp.net" })
      ?.participanteNumero,
    null,
  );
});

Deno.test("normalizarJidGrupo exige o sufixo @g.us", () => {
  assertEquals(normalizarJidGrupo("120363012345678901"), null);
  assertEquals(normalizarJidGrupo(JID), JID);
});

Deno.test("isGroup:true com chatid individual NÃO é grupo (não pode engolir mensagem)", () => {
  // Payload forjado com isGroup:true e chat individual entraria no desvio de
  // grupo, não resolveria JID e a mensagem do cliente seria descartada. O
  // roteamento tem que olhar o JID, não a flag.
  assertEquals(
    extrairIdentidadeGrupo({
      chatid: "5511999998888@s.whatsapp.net",
      isGroup: true,
      sender: "5511999998888@s.whatsapp.net",
    }),
    null,
  );
});

Deno.test("extrairNomeGrupo: pega do objeto chat do envelope", () => {
  assertEquals(
    extrairNomeGrupo({ chatid: JID }, { chat: { wa_name: "Obra Centro" } }),
    "Obra Centro",
  );
});

Deno.test("extrairNomeGrupo: null quando não há nome", () => {
  assertEquals(extrairNomeGrupo({ chatid: JID }, {}), null);
  assertEquals(extrairNomeGrupo({ chatid: JID }, { chat: { wa_name: "5511999998888" } }), null);
});
