// Edge Function: sincronizar-grupos
// Puxa a lista de grupos da instância uazapi (GET /group/list) e reflete no
// banco, para que a aba "Grupos" do Inbox mostre também os grupos calados
// (que nunca mandaram mensagem) e permita iniciar a conversa.
//
// Contrato com o frontend:
//   POST {}  → { ok: true, total, novos, desativados }
//
// Autorização: qualquer membro ativo da empresa. Grupo não tem atribuição —
// por decisão de produto todo colaborador vê e usa todos os grupos.
//
// Idempotente: upsert por (company_id, wa_jid). Rodar duas vezes não duplica.
// Grupo que a uazapi não lista mais é DESATIVADO, nunca apagado (o histórico de
// mensagens continua acessível).

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { listarGrupos, ZapiError } from "../_shared/uazapi-client.ts";
import { exigirMembroAtivo } from "../_shared/empresa.ts";
import { type GrupoExistente, planejarSincronizacao } from "./logic.ts";

const FUNCAO = "sincronizar-grupos";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);
  }

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // 1) Autenticação.
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!jwt) {
    log({ funcao: FUNCAO, evento: "sem_token", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }
  const { data: userRes, error: errUser } = await supabase.auth.getUser(jwt);
  if (errUser || !userRes?.user) {
    log({ funcao: FUNCAO, evento: "token_invalido", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }
  const userId = userRes.user.id;

  // Exige vínculo ativo + usuário ativo (ver _shared/empresa.ts).
  const membro = await exigirMembroAtivo(supabase, userId);
  if (!membro) {
    log({ funcao: FUNCAO, evento: "sem_vinculo_ativo", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "forbidden" }, 403);
  }
  const companyId = membro.companyId;

  try {
    // 2) Lista atual na uazapi.
    const daUazapi = await listarGrupos();

    // 3) O que já existe no banco para esta empresa.
    const { data: existentes, error: errSel } = await supabase
      .from("grupos")
      .select("id, wa_jid, ativo")
      .eq("company_id", companyId);
    if (errSel) throw new Error(`select_grupos: ${errSel.message}`);

    const plano = planejarSincronizacao({
      companyId,
      agoraIso: new Date().toISOString(),
      daUazapi,
      noBanco: (existentes ?? []) as GrupoExistente[],
    });

    // 4) Salvaguarda: lista vazia com grupos ativos no banco é provável resposta
    // malformada da uazapi (ver planejarSincronizacao). Aborta ANTES de gravar
    // qualquer coisa, para a tela avisar em vez de a aba Grupos esvaziar.
    if (plano.respostaVaziaSuspeita) {
      log({
        funcao: FUNCAO,
        evento: "resposta_vazia_suspeita",
        status: "erro",
        duracao_ms: cron(),
        extra: { ativos_no_banco: (existentes ?? []).filter((g) => g.ativo).length },
      });
      return jsonResponse({ ok: false, erro: "lista_vazia_inesperada" }, 502);
    }

    // 5) Upsert dos grupos vivos.
    if (plano.upserts.length > 0) {
      const { error: errUp } = await supabase
        .from("grupos")
        .upsert(plano.upserts, { onConflict: "company_id,wa_jid" });
      if (errUp) throw new Error(`upsert_grupos: ${errUp.message}`);
    }

    // 6) Desativa os que saíram da lista.
    if (plano.idsParaDesativar.length > 0) {
      const { error: errDes } = await supabase
        .from("grupos")
        .update({ ativo: false, synced_at: new Date().toISOString() })
        .in("id", plano.idsParaDesativar);
      if (errDes) throw new Error(`desativar_grupos: ${errDes.message}`);
    }

    log({
      funcao: FUNCAO,
      evento: "sincronizacao_concluida",
      status: "ok",
      duracao_ms: cron(),
      extra: {
        total: plano.upserts.length,
        novos: plano.novos,
        desativados: plano.idsParaDesativar.length,
      },
    });

    return jsonResponse({
      ok: true,
      total: plano.upserts.length,
      novos: plano.novos,
      desativados: plano.idsParaDesativar.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ehUazapi = err instanceof ZapiError;
    log({
      funcao: FUNCAO,
      evento: ehUazapi ? "uazapi_erro" : "erro_inesperado",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: msg.slice(0, 200),
    });
    return jsonResponse(
      {
        ok: false,
        erro: ehUazapi ? "uazapi_indisponivel" : "erro_interno",
        detalhe: ehUazapi ? "Não foi possível falar com o WhatsApp agora." : undefined,
      },
      ehUazapi ? 502 : 500,
    );
  }
});
