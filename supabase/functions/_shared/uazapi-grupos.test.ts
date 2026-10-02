// Testes do mapeamento do objeto Group da uazapi.
// Rodar: deno test supabase/functions/_shared/uazapi-grupos.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extrairGruposDaResposta,
  extrairParticipantesDaResposta,
  mapearGrupoUazapi,
  normalizarJidGrupo,
} from "./uazapi-grupos.ts";

Deno.test("normalizarJidGrupo: JID de grupo é canonizado", () => {
  assertEquals(normalizarJidGrupo("120363012345678901@g.us"), "120363012345678901@g.us");
});

Deno.test("normalizarJidGrupo: aceita id cru sem sufixo", () => {
  assertEquals(normalizarJidGrupo("120363012345678901"), "120363012345678901@g.us");
});

Deno.test("normalizarJidGrupo: rejeita chat individual", () => {
  assertEquals(normalizarJidGrupo("5511999998888@s.whatsapp.net"), null);
  assertEquals(normalizarJidGrupo("5511999998888@lid"), null);
});

Deno.test("normalizarJidGrupo: rejeita vazio e não-string", () => {
  assertEquals(normalizarJidGrupo(""), null);
  assertEquals(normalizarJidGrupo(null), null);
  assertEquals(normalizarJidGrupo(42), null);
  assertEquals(normalizarJidGrupo("123@g.us"), null); // menos de 5 dígitos
});

Deno.test("mapearGrupoUazapi: schema oficial em PascalCase", () => {
  const g = mapearGrupoUazapi({
    JID: "120363012345678901@g.us",
    Name: "Obra Centro",
    Topic: "Andamento da obra",
    Participants: [{ JID: "a" }, { JID: "b" }, { JID: "c" }],
    IsAnnounce: false,
    OwnerIsAdmin: true,
  });
  assertEquals(g, {
    jid: "120363012345678901@g.us",
    nome: "Obra Centro",
    topico: "Andamento da obra",
    fotoUrl: null,
    participantesTotal: 3,
    souAdmin: true,
    somenteAdminEnvia: false,
  });
});

Deno.test("mapearGrupoUazapi: aceita variantes camelCase/wa_*", () => {
  const g = mapearGrupoUazapi({
    chatid: "120363099999999999@g.us",
    wa_name: "Financeiro",
    description: "Só financeiro",
    imgUrl: "https://exemplo/foto.jpg",
    participantsCount: 12,
    wa_isGroup_announce: true,
    wa_isGroup_admin: false,
  });
  assertEquals(g?.jid, "120363099999999999@g.us");
  assertEquals(g?.nome, "Financeiro");
  assertEquals(g?.topico, "Só financeiro");
  assertEquals(g?.fotoUrl, "https://exemplo/foto.jpg");
  assertEquals(g?.participantesTotal, 12);
  assertEquals(g?.somenteAdminEnvia, true);
  assertEquals(g?.souAdmin, false);
});

Deno.test("mapearGrupoUazapi: sem flag de admin, announce + pode enviar implica admin", () => {
  const g = mapearGrupoUazapi({
    JID: "120363012345678901@g.us",
    IsAnnounce: true,
    OwnerCanSendMessage: true,
  });
  assertEquals(g?.souAdmin, true);
});

Deno.test("mapearGrupoUazapi: announce sem poder enviar não é admin", () => {
  const g = mapearGrupoUazapi({
    JID: "120363012345678901@g.us",
    IsAnnounce: true,
    OwnerCanSendMessage: false,
  });
  assertEquals(g?.souAdmin, false);
  assertEquals(g?.somenteAdminEnvia, true);
});

Deno.test("mapearGrupoUazapi: sem JID de grupo retorna null", () => {
  assertEquals(mapearGrupoUazapi({ Name: "Sem jid" }), null);
  assertEquals(mapearGrupoUazapi({ JID: "5511999998888@s.whatsapp.net" }), null);
  assertEquals(mapearGrupoUazapi(null), null);
  assertEquals(mapearGrupoUazapi("texto"), null);
});

Deno.test("mapearGrupoUazapi: flags ausentes viram false, não null", () => {
  const g = mapearGrupoUazapi({ JID: "120363012345678901@g.us" });
  assertEquals(g?.souAdmin, false);
  assertEquals(g?.somenteAdminEnvia, false);
  assertEquals(g?.participantesTotal, null);
});

Deno.test("extrairGruposDaResposta: array cru", () => {
  const lista = extrairGruposDaResposta([
    { JID: "120363000000000001@g.us", Name: "A" },
    { JID: "120363000000000002@g.us", Name: "B" },
  ]);
  assertEquals(lista.map((g) => g.nome), ["A", "B"]);
});

Deno.test("extrairGruposDaResposta: envelope { groups }", () => {
  const lista = extrairGruposDaResposta({
    groups: [{ JID: "120363000000000001@g.us", Name: "A" }],
  });
  assertEquals(lista.length, 1);
});

Deno.test("extrairGruposDaResposta: descarta inválidos e JID repetido", () => {
  const lista = extrairGruposDaResposta([
    { JID: "120363000000000001@g.us", Name: "A" },
    { JID: "120363000000000001@g.us", Name: "A duplicado" },
    { Name: "sem jid" },
    { JID: "5511999998888@s.whatsapp.net", Name: "pessoa" },
  ]);
  assertEquals(lista.length, 1);
  assertEquals(lista[0].nome, "A");
});

Deno.test("extrairGruposDaResposta: resposta inesperada devolve lista vazia", () => {
  assertEquals(extrairGruposDaResposta(null), []);
  assertEquals(extrairGruposDaResposta("erro"), []);
  assertEquals(extrairGruposDaResposta({ groups: "nope" }), []);
});

Deno.test("extrairParticipantesDaResposta: schema oficial em PascalCase", () => {
  const lista = extrairParticipantesDaResposta({
    JID: "120363012345678901@g.us",
    Participants: [
      { PhoneNumber: "5511999998888@s.whatsapp.net", IsAdmin: true },
      { JID: "5521988887777@s.whatsapp.net", DisplayName: "Anônimo" },
    ],
  });
  assertEquals(lista, [
    { numero: "5511999998888", nome: null },
    { numero: "5521988887777", nome: "Anônimo" },
  ]);
});

Deno.test("extrairParticipantesDaResposta: aceita envelope { group: {...} }", () => {
  const lista = extrairParticipantesDaResposta({
    group: { Participants: [{ JID: "5511999998888@s.whatsapp.net" }] },
  });
  assertEquals(lista, [{ numero: "5511999998888", nome: null }]);
});

Deno.test("extrairParticipantesDaResposta: descarta sem número e dedupe por número", () => {
  const lista = extrairParticipantesDaResposta({
    Participants: [
      { JID: "5511999998888@s.whatsapp.net" },
      { JID: "5511999998888@s.whatsapp.net", DisplayName: "Repetido" },
      { DisplayName: "sem numero" },
    ],
  });
  assertEquals(lista.length, 1);
  assertEquals(lista[0].numero, "5511999998888");
});

Deno.test("extrairParticipantesDaResposta: resposta sem Participants devolve lista vazia", () => {
  assertEquals(extrairParticipantesDaResposta(null), []);
  assertEquals(extrairParticipantesDaResposta({}), []);
  assertEquals(extrairParticipantesDaResposta({ Participants: "nope" }), []);
});

Deno.test("mapearGrupoUazapi: usa a foto persistida da /group/info (preview primeiro)", () => {
  const g = mapearGrupoUazapi({
    JID: "120363000000000001@g.us",
    Name: "Oficina",
    image_url: "https://uazapi.example/full.jpg",
    image_preview_url: "https://uazapi.example/preview.jpg",
  });
  assertEquals(g?.fotoUrl, "https://uazapi.example/preview.jpg");
});
