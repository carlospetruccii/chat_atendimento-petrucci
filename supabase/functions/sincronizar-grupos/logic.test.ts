// Testes do diff de sincronização de grupos.
// Rodar: deno test supabase/functions/sincronizar-grupos/logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { planejarSincronizacao } from "./logic.ts";
import type { GrupoUazapi } from "../_shared/uazapi-grupos.ts";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const AGORA = "2026-07-27T12:00:00.000Z";

function grupo(jid: string, nome = "Grupo"): GrupoUazapi {
  return {
    jid,
    nome,
    topico: null,
    fotoUrl: null,
    participantesTotal: 3,
    souAdmin: false,
    somenteAdminEnvia: false,
  };
}

Deno.test("banco vazio: tudo é novo, nada a desativar", () => {
  const plano = planejarSincronizacao({
    companyId: COMPANY,
    agoraIso: AGORA,
    daUazapi: [grupo("120363000000000001@g.us"), grupo("120363000000000002@g.us")],
    noBanco: [],
  });
  assertEquals(plano.upserts.length, 2);
  assertEquals(plano.novos, 2);
  assertEquals(plano.idsParaDesativar, []);
  assertEquals(plano.upserts[0].company_id, COMPANY);
  assertEquals(plano.upserts[0].synced_at, AGORA);
  assertEquals(plano.upserts[0].ativo, true);
});

Deno.test("grupo que já existe não conta como novo, mas é atualizado", () => {
  const plano = planejarSincronizacao({
    companyId: COMPANY,
    agoraIso: AGORA,
    daUazapi: [grupo("120363000000000001@g.us", "Nome novo")],
    noBanco: [{ id: "g1", wa_jid: "120363000000000001@g.us", ativo: true }],
  });
  assertEquals(plano.novos, 0);
  assertEquals(plano.upserts.length, 1);
  assertEquals(plano.upserts[0].nome, "Nome novo");
  assertEquals(plano.idsParaDesativar, []);
});

Deno.test("grupo que saiu da lista da uazapi é desativado, não apagado", () => {
  const plano = planejarSincronizacao({
    companyId: COMPANY,
    agoraIso: AGORA,
    daUazapi: [grupo("120363000000000001@g.us")],
    noBanco: [
      { id: "g1", wa_jid: "120363000000000001@g.us", ativo: true },
      { id: "g2", wa_jid: "120363000000000002@g.us", ativo: true },
    ],
  });
  assertEquals(plano.idsParaDesativar, ["g2"]);
});

Deno.test("grupo já inativo e ausente não entra na lista de desativação", () => {
  const plano = planejarSincronizacao({
    companyId: COMPANY,
    agoraIso: AGORA,
    daUazapi: [],
    noBanco: [{ id: "g2", wa_jid: "120363000000000002@g.us", ativo: false }],
  });
  assertEquals(plano.idsParaDesativar, []);
});

Deno.test("grupo inativo que voltou a aparecer é reativado pelo upsert", () => {
  const plano = planejarSincronizacao({
    companyId: COMPANY,
    agoraIso: AGORA,
    daUazapi: [grupo("120363000000000002@g.us")],
    noBanco: [{ id: "g2", wa_jid: "120363000000000002@g.us", ativo: false }],
  });
  assertEquals(plano.upserts.length, 1);
  assertEquals(plano.upserts[0].ativo, true);
  assertEquals(plano.idsParaDesativar, []);
});

Deno.test("SALVAGUARDA: lista vazia com grupos ativos NÃO desativa nada", () => {
  // Resposta 2xx com envelope desconhecido chega aqui como lista vazia. Sem esta
  // salvaguarda, todos os grupos da empresa sumiriam da tela de uma vez.
  const plano = planejarSincronizacao({
    companyId: COMPANY,
    agoraIso: AGORA,
    daUazapi: [],
    noBanco: [
      { id: "g1", wa_jid: "120363000000000001@g.us", ativo: true },
      { id: "g2", wa_jid: "120363000000000002@g.us", ativo: true },
    ],
  });
  assertEquals(plano.respostaVaziaSuspeita, true);
  assertEquals(plano.idsParaDesativar, []);
  assertEquals(plano.upserts, []);
});

Deno.test("lista vazia com banco vazio não é suspeita (empresa sem grupo nenhum)", () => {
  const plano = planejarSincronizacao({
    companyId: COMPANY,
    agoraIso: AGORA,
    daUazapi: [],
    noBanco: [],
  });
  assertEquals(plano.respostaVaziaSuspeita, false);
  assertEquals(plano.idsParaDesativar, []);
});

Deno.test("lista vazia com banco só de inativos não é suspeita", () => {
  const plano = planejarSincronizacao({
    companyId: COMPANY,
    agoraIso: AGORA,
    daUazapi: [],
    noBanco: [{ id: "g1", wa_jid: "120363000000000001@g.us", ativo: false }],
  });
  assertEquals(plano.respostaVaziaSuspeita, false);
  assertEquals(plano.idsParaDesativar, []);
});

Deno.test("lista parcial segue desativando: é sinal legítimo, não defeito", () => {
  const plano = planejarSincronizacao({
    companyId: COMPANY,
    agoraIso: AGORA,
    daUazapi: [grupo("120363000000000001@g.us")],
    noBanco: [
      { id: "g1", wa_jid: "120363000000000001@g.us", ativo: true },
      { id: "g2", wa_jid: "120363000000000002@g.us", ativo: true },
      { id: "g3", wa_jid: "120363000000000003@g.us", ativo: true },
    ],
  });
  assertEquals(plano.respostaVaziaSuspeita, false);
  assertEquals(plano.idsParaDesativar.sort(), ["g2", "g3"]);
});

Deno.test("flags de admin/announce são propagadas para o upsert", () => {
  const g: GrupoUazapi = {
    ...grupo("120363000000000009@g.us"),
    souAdmin: true,
    somenteAdminEnvia: true,
  };
  const plano = planejarSincronizacao({
    companyId: COMPANY,
    agoraIso: AGORA,
    daUazapi: [g],
    noBanco: [],
  });
  assertEquals(plano.upserts[0].sou_admin, true);
  assertEquals(plano.upserts[0].somente_admin_envia, true);
});
