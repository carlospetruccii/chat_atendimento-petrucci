// Edge Function: google-contacts
// Backend da integração com os contatos do Google (People API).
//
// Ações (POST { action }):
//   - status      → { ok, configured, connected, email, last_sync_at, contacts_count, ... }
//   - auth_url    → { ok, url }   (URL de consentimento do Google; body: { redirect_back })
//   - sync        → { ok, criados, atualizados, removidos, total }
//   - disconnect  → { ok }
//
// Callback OAuth (GET ?code&state): o Google redireciona o navegador para cá;
// trocamos o code por tokens, guardamos, rodamos o 1º sync e voltamos ao app.
//
// SEGURANÇA: tokens do Google NUNCA vão ao frontend. Ficam em
// public.google_integration (RLS sem policy → só service_role). O frontend só
// vê status pela ação "status".

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import {
  buscarEmailConta,
  googleConfigurado,
  GoogleError,
  listarConexoes,
  montarAuthUrl,
  type PessoaContato,
  renovarAccessToken,
  revogarToken,
  trocarCodePorToken,
} from "../_shared/google-people.ts";

const FUNCAO = "google-contacts";
const EMPRESA_EXEMPLO_ID = "11111111-1111-1111-1111-111111111111";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// URL fixa deste endpoint (precisa bater com o "URI de redirecionamento
// autorizado" cadastrado no Google Cloud).
function redirectUri(): string {
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  return `${base}/functions/v1/${FUNCAO}`;
}

type IntegrationRow = {
  id: string;
  connected: boolean;
  connected_email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: string | null;
  sync_token: string | null;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  contacts_count: number;
};

type Supa = ReturnType<typeof getSupabaseAdmin>;

async function lerIntegracao(supabase: Supa): Promise<IntegrationRow | null> {
  const { data } = await supabase
    .from("google_integration")
    .select(
      "id, connected, connected_email, access_token, refresh_token, token_expiry, sync_token, last_sync_at, last_sync_status, last_sync_error, contacts_count",
    )
    .eq("company_id", EMPRESA_EXEMPLO_ID)
    .maybeSingle();
  return (data as IntegrationRow | null) ?? null;
}

async function upsertIntegracao(
  supabase: Supa,
  patch: Record<string, unknown>,
): Promise<void> {
  await supabase
    .from("google_integration")
    .upsert(
      { company_id: EMPRESA_EXEMPLO_ID, ...patch },
      { onConflict: "company_id" },
    );
}

// Garante um access_token válido (renova se estiver expirado/perto de expirar).
async function garantirAccessToken(
  supabase: Supa,
  integ: IntegrationRow,
): Promise<string> {
  const agora = Date.now();
  const expiraEm = integ.token_expiry ? new Date(integ.token_expiry).getTime() : 0;
  if (integ.access_token && expiraEm - 60_000 > agora) {
    return integ.access_token;
  }
  if (!integ.refresh_token) throw new Error("sem_refresh_token");
  const tok = await renovarAccessToken(integ.refresh_token);
  const novoExpiry = new Date(agora + tok.expires_in * 1000).toISOString();
  await upsertIntegracao(supabase, {
    access_token: tok.access_token,
    token_expiry: novoExpiry,
  });
  integ.access_token = tok.access_token;
  integ.token_expiry = novoExpiry;
  return tok.access_token;
}

// Aplica uma leva de contatos no banco (upsert dos ativos, delete dos removidos).
async function aplicarContatos(
  supabase: Supa,
  contatos: PessoaContato[],
): Promise<{ criados: number; atualizados: number; removidos: number }> {
  let removidos = 0;
  const upserts: Record<string, unknown>[] = [];
  const removerResources: string[] = [];

  for (const c of contatos) {
    if (!c.resourceName) continue;
    if (c.deleted) {
      removerResources.push(c.resourceName);
      continue;
    }
    upserts.push({
      company_id: EMPRESA_EXEMPLO_ID,
      google_resource_name: c.resourceName,
      nome: c.nome,
      numero_whatsapp: c.numeroE164,
      numero_raw: c.numeroRaw,
      emails: c.emails,
      etag: c.etag,
    });
  }

  let afetados = 0;
  if (upserts.length > 0) {
    const { data, error } = await supabase
      .from("contatos")
      .upsert(upserts, { onConflict: "company_id,google_resource_name" })
      .select("id");
    if (error) throw new Error(`upsert_contatos: ${error.message}`);
    afetados = data?.length ?? 0;
  }

  if (removerResources.length > 0) {
    const { error } = await supabase
      .from("contatos")
      .delete()
      .eq("company_id", EMPRESA_EXEMPLO_ID)
      .in("google_resource_name", removerResources);
    if (!error) removidos = removerResources.length;
  }

  // Não separamos criados/atualizados no upsert em lote; reportamos o total
  // afetado como "atualizados" (a UI só mostra o total mesmo).
  return { criados: 0, atualizados: afetados, removidos };
}

// Executa uma sincronização completa ou incremental.
async function sincronizar(
  supabase: Supa,
  integ: IntegrationRow,
): Promise<{ total: number; atualizados: number; removidos: number }> {
  const accessToken = await garantirAccessToken(supabase, integ);

  let syncToken = integ.sync_token;
  let usarIncremental = Boolean(syncToken);
  let atualizados = 0;
  let removidos = 0;

  const rodar = async (tokenInicial: string | null) => {
    let pageToken: string | null = null;
    let novoSyncToken: string | null = null;
    let localAtualizados = 0;
    let localRemovidos = 0;
    do {
      const page = await listarConexoes({
        accessToken,
        pageToken,
        syncToken: tokenInicial,
      });
      const res = await aplicarContatos(supabase, page.contatos);
      localAtualizados += res.atualizados;
      localRemovidos += res.removidos;
      pageToken = page.nextPageToken;
      if (page.nextSyncToken) novoSyncToken = page.nextSyncToken;
    } while (pageToken);
    return { novoSyncToken, localAtualizados, localRemovidos };
  };

  let resultado;
  try {
    resultado = await rodar(usarIncremental ? syncToken : null);
  } catch (err) {
    // 410 GONE → syncToken expirou; refaz do zero (full sync).
    if (err instanceof GoogleError && err.status === 410) {
      log({ funcao: FUNCAO, evento: "sync_token_expirado", status: "ok" });
      usarIncremental = false;
      syncToken = null;
      resultado = await rodar(null);
    } else {
      throw err;
    }
  }

  atualizados = resultado.localAtualizados;
  removidos = resultado.localRemovidos;

  // Conta o total atual de contatos.
  const { count } = await supabase
    .from("contatos")
    .select("*", { head: true, count: "exact" })
    .eq("company_id", EMPRESA_EXEMPLO_ID);

  await upsertIntegracao(supabase, {
    sync_token: resultado.novoSyncToken ?? syncToken,
    last_sync_at: new Date().toISOString(),
    last_sync_status: "ok",
    last_sync_error: null,
    contacts_count: count ?? 0,
  });

  return { total: count ?? 0, atualizados, removidos };
}

// Página HTML simples de retorno do callback (fallback quando não há para onde
// redirecionar). Fecha sozinha se aberta em popup.
function htmlCallback(msg: string, sucesso: boolean): Response {
  const cor = sucesso ? "#059669" : "#dc2626";
  const html = `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Google — Almore</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f8fafc">
<div style="text-align:center;max-width:420px;padding:32px">
<div style="font-size:40px">${sucesso ? "✅" : "⚠️"}</div>
<h1 style="color:${cor};font-size:18px">${msg}</h1>
<p style="color:#64748b;font-size:14px">Você já pode voltar para o sistema.</p>
</div></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();
  const url = new URL(req.url);

  // -------- Callback OAuth (navegador chega via GET com ?code) --------
  if (req.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("error"))) {
    let redirectBack: string | null = null;
    const state = url.searchParams.get("state");
    if (state) {
      try {
        const parsed = JSON.parse(atob(state)) as { redirect_back?: string };
        if (typeof parsed.redirect_back === "string") redirectBack = parsed.redirect_back;
      } catch {
        // state inválido → ignora
      }
    }

    const voltar = (ok: boolean) => {
      if (redirectBack) {
        const sep = redirectBack.includes("?") ? "&" : "?";
        const loc = `${redirectBack}${sep}google=${ok ? "connected" : "error"}`;
        return new Response(null, { status: 302, headers: { ...CORS_HEADERS, Location: loc } });
      }
      return htmlCallback(
        ok ? "Conta Google conectada!" : "Não foi possível conectar a conta Google.",
        ok,
      );
    };

    if (url.searchParams.has("error")) {
      log({ funcao: FUNCAO, evento: "oauth_erro", status: "erro", extra: { erro: url.searchParams.get("error") } });
      return voltar(false);
    }

    try {
      const code = url.searchParams.get("code")!;
      const tok = await trocarCodePorToken(code, redirectUri());
      const email = await buscarEmailConta(tok.access_token);
      const expiry = new Date(Date.now() + tok.expires_in * 1000).toISOString();

      await upsertIntegracao(supabase, {
        connected: true,
        connected_email: email,
        access_token: tok.access_token,
        // refresh_token só vem na 1ª autorização; preserva o anterior se ausente.
        ...(tok.refresh_token ? { refresh_token: tok.refresh_token } : {}),
        token_expiry: expiry,
        scope: tok.scope ?? null,
        sync_token: null, // força full sync inicial
        last_sync_status: null,
        last_sync_error: null,
      });

      log({ funcao: FUNCAO, evento: "oauth_conectado", status: "ok", duracao_ms: cron() });

      // 1º sync em background (não trava o redirect de volta ao app).
      const integ = await lerIntegracao(supabase);
      if (integ) {
        const tarefa = sincronizar(supabase, integ)
          .then((r) => log({ funcao: FUNCAO, evento: "sync_inicial", status: "ok", extra: { total: r.total } }))
          .catch(async (err) => {
            await upsertIntegracao(supabase, {
              last_sync_status: "erro",
              last_sync_error: err instanceof Error ? err.message.slice(0, 200) : "erro",
            });
            log({ funcao: FUNCAO, evento: "sync_inicial_erro", status: "erro", erro_msg: String(err).slice(0, 200) });
          });
        const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
        if (edge?.waitUntil) edge.waitUntil(tarefa);
        else tarefa.catch(() => {});
      }

      return voltar(true);
    } catch (err) {
      log({ funcao: FUNCAO, evento: "oauth_callback_erro", status: "erro", erro_msg: String(err).slice(0, 200) });
      return voltar(false);
    }
  }

  // -------- Ações POST (chamadas pelo frontend / cron) --------
  let action = "status";
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (typeof body.action === "string") action = body.action;
  } catch {
    // sem corpo → status
  }

  const configured = googleConfigurado();

  try {
    if (action === "status") {
      const integ = await lerIntegracao(supabase);
      return jsonResponse({
        ok: true,
        configured,
        connected: Boolean(integ?.connected),
        email: integ?.connected_email ?? null,
        last_sync_at: integ?.last_sync_at ?? null,
        last_sync_status: integ?.last_sync_status ?? null,
        last_sync_error: integ?.last_sync_error ?? null,
        contacts_count: integ?.contacts_count ?? 0,
      });
    }

    if (!configured) {
      return jsonResponse({
        ok: false,
        erro: "google_nao_configurado",
        detalhe: "Faltam os secrets GOOGLE_CLIENT_ID e/ou GOOGLE_CLIENT_SECRET.",
      });
    }

    if (action === "auth_url") {
      const redirectBack = typeof body.redirect_back === "string" ? body.redirect_back : null;
      const state = btoa(JSON.stringify({ redirect_back: redirectBack }));
      const authUrl = montarAuthUrl(redirectUri(), state);
      return jsonResponse({ ok: true, url: authUrl });
    }

    if (action === "sync") {
      const integ = await lerIntegracao(supabase);
      if (!integ?.connected || !integ.refresh_token) {
        return jsonResponse({ ok: false, erro: "nao_conectado", detalhe: "Conecte a conta Google primeiro." });
      }
      try {
        const r = await sincronizar(supabase, integ);
        log({ funcao: FUNCAO, evento: "sync", status: "ok", duracao_ms: cron(), extra: { total: r.total, atualizados: r.atualizados, removidos: r.removidos } });
        return jsonResponse({ ok: true, ...r });
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 200) : "erro";
        await upsertIntegracao(supabase, { last_sync_status: "erro", last_sync_error: msg });
        log({ funcao: FUNCAO, evento: "sync_erro", status: "erro", erro_msg: msg });
        return jsonResponse({ ok: false, erro: "falha_sync", detalhe: msg });
      }
    }

    if (action === "disconnect") {
      const integ = await lerIntegracao(supabase);
      if (integ?.refresh_token) await revogarToken(integ.refresh_token);
      await upsertIntegracao(supabase, {
        connected: false,
        access_token: null,
        refresh_token: null,
        token_expiry: null,
        sync_token: null,
      });
      log({ funcao: FUNCAO, evento: "disconnect", status: "ok", duracao_ms: cron() });
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, erro: "action_invalida" }, 400);
  } catch (err) {
    const status = err instanceof GoogleError ? err.status : 500;
    log({ funcao: FUNCAO, evento: "erro", status: "erro", duracao_ms: cron(), erro_msg: String(err).slice(0, 200), extra: { action } });
    return jsonResponse({ ok: false, erro: "falha_google", detalhe: String(err).slice(0, 200), http: status });
  }
});
