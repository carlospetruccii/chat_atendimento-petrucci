// Edge Function: whatsapp-connection
// Backend da TELA DE CONEXÃO do WhatsApp (uazapi). O frontend chama esta função
// para ver o status da instância, pedir o QR code para parear, ou desconectar.
//
// SEGURANÇA: o token da instância NUNCA sai do backend. Esta função usa o secret
// UAZAPI_TOKEN internamente e devolve para a tela apenas: status de conexão,
// número conectado e a imagem do QR code (base64). Nenhum token é exposto.
//
// Contrato:
//   POST { action: "status" | "connect" | "disconnect" }
//   → status:     { ok, connected, loggedIn, status, profileName, numero }
//   → connect:    { ok, connected, loggedIn, qrcode, paircode }
//   → disconnect: { ok }
//
// Ao conectar, também (re)configura o webhook da instância apontando para a
// função webhook-zapi-receive (com o secret na query), de forma idempotente.

import { iniciarCronometro, log } from "../_shared/logger.ts";
import {
  conectarInstancia,
  configurarWebhook,
  desconectarInstancia,
  statusInstancia,
  UazapiError,
} from "../_shared/uazapi-client.ts";

const FUNCAO = "whatsapp-connection";

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

function credenciaisConfiguradas(): boolean {
  return Boolean(Deno.env.get("UAZAPI_URL") && Deno.env.get("UAZAPI_TOKEN"));
}

// Monta a URL pública do webhook (com secret, se configurado).
function urlWebhook(): string | null {
  const base = Deno.env.get("SUPABASE_URL");
  if (!base) return null;
  const secret = Deno.env.get("UAZAPI_WEBHOOK_SECRET");
  const url = `${base.replace(/\/+$/, "")}/functions/v1/webhook-zapi-receive`;
  return secret ? `${url}?secret=${encodeURIComponent(secret)}` : url;
}

// Garante que o webhook da instância aponta para cá (idempotente).
async function garantirWebhook(): Promise<void> {
  const url = urlWebhook();
  if (!url) return;
  try {
    await configurarWebhook({ url });
    log({ funcao: FUNCAO, evento: "webhook_configurado", status: "ok" });
  } catch (err) {
    // Não derruba a conexão se o webhook falhar; apenas registra.
    log({
      funcao: FUNCAO,
      evento: "webhook_config_falhou",
      status: "erro",
      erro_msg: err instanceof Error ? err.message : String(err),
    });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();

  if (!credenciaisConfiguradas()) {
    return jsonResponse({
      ok: false,
      erro: "uazapi_nao_configurado",
      detalhe: "Faltam os secrets UAZAPI_URL e/ou UAZAPI_TOKEN.",
    });
  }

  let action = "status";
  try {
    const body = (await req.json()) as { action?: string };
    if (body?.action) action = String(body.action);
  } catch {
    // sem corpo → assume "status"
  }

  try {
    if (action === "status") {
      const st = await statusInstancia();
      log({ funcao: FUNCAO, evento: "status", status: "ok", duracao_ms: cron(), extra: { connected: st.connected, loggedIn: st.loggedIn } });
      return jsonResponse({
        ok: true,
        connected: st.connected,
        loggedIn: st.loggedIn,
        status: st.status ?? null,
        profileName: st.profileName ?? null,
        numero: st.numero ?? null,
      });
    }

    if (action === "connect") {
      const res = await conectarInstancia();
      // Configura o webhook em paralelo (não bloqueia a resposta do QR).
      const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (edge?.waitUntil) edge.waitUntil(garantirWebhook());
      else garantirWebhook().catch(() => {});

      log({ funcao: FUNCAO, evento: "connect", status: "ok", duracao_ms: cron(), extra: { connected: res.connected, tem_qr: Boolean(res.qrcode) } });
      return jsonResponse({
        ok: true,
        connected: res.connected,
        loggedIn: res.loggedIn,
        qrcode: res.qrcode ?? null,
        paircode: res.paircode ?? null,
      });
    }

    if (action === "disconnect") {
      await desconectarInstancia();
      log({ funcao: FUNCAO, evento: "disconnect", status: "ok", duracao_ms: cron() });
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, erro: "action_invalida" }, 400);
  } catch (err) {
    const status = err instanceof UazapiError ? err.status : 500;
    log({
      funcao: FUNCAO,
      evento: "erro",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: err instanceof Error ? err.message : String(err),
      extra: { action, http: status },
    });
    return jsonResponse({
      ok: false,
      erro: "falha_uazapi",
      detalhe: err instanceof Error ? err.message.slice(0, 200) : "erro",
      http: status,
    });
  }
});
