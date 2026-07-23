// Edge Function: webhook-meta-whatsapp
// Endpoint público para a API oficial da Meta (WhatsApp Cloud API).
//
// GET  -> handshake de verificação do webhook. A Meta chama com
//         ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
//         e espera 200 com o `hub.challenge` em texto puro (não JSON).
// POST -> eventos reais (mensagens/status). Por ora só loga e responde 200
//         (conexão apenas — processamento de mensagens fica para depois).
//
// Validação de origem: hub.verify_token (GET) comparado a
// META_WHATSAPP_VERIFY_TOKEN. A Meta não envia Authorization, por isso esta
// função roda com verify_jwt = false (ver supabase/config.toml).

import { iniciarCronometro, log } from "../_shared/logger.ts";

const FUNCAO = "webhook-meta-whatsapp";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function handleVerify(req: Request): Response {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expectedToken = Deno.env.get("META_WHATSAPP_VERIFY_TOKEN");

  if (mode === "subscribe" && expectedToken && token === expectedToken && challenge) {
    log({ funcao: FUNCAO, evento: "handshake_ok", status: "ok" });
    return new Response(challenge, {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "text/plain" },
    });
  }

  log({ funcao: FUNCAO, evento: "handshake_falhou", status: "erro" });
  return jsonResponse({ ok: false, erro: "verify_token_invalido" }, 403);
}

async function handleEvent(req: Request): Promise<Response> {
  const cron = iniciarCronometro();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    log({ funcao: FUNCAO, evento: "payload_invalido", status: "erro", duracao_ms: cron() });
    // 200 mesmo assim para a Meta não reentregar payload quebrado.
    return jsonResponse({ ok: true, ignorado: "payload_invalido" });
  }

  const entryCount = Array.isArray((body as Record<string, unknown>)?.entry)
    ? ((body as Record<string, unknown>).entry as unknown[]).length
    : 0;

  log({
    funcao: FUNCAO,
    evento: "evento_recebido",
    status: "ok",
    duracao_ms: cron(),
    extra: { entry_count: entryCount },
  });

  return jsonResponse({ ok: true });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method === "GET") {
    return handleVerify(req);
  }
  if (req.method === "POST") {
    return await handleEvent(req);
  }
  return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);
});
