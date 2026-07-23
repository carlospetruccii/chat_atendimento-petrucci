// Edge Function: whatsapp-send
// Endpoint de TESTE para enviar mensagem de texto livre via WhatsApp Cloud
// API (Meta oficial) — separado do fluxo de produção (send-whatsapp-message,
// que usa a uazapi). Recebe POST { to, message } e repassa pra Graph API.
//
// Mensagem de texto livre só entrega se houver janela de 24h aberta com o
// destino (o destinatário precisa ter mandado mensagem pro número da empresa
// nas últimas 24h). Fora da janela a Meta retorna erro (ex.: code 131047,
// "re-engagement message" / "message undeliverable") — não é bug da função.
//
// TEMPORÁRIO: deploy com verify_jwt = false a pedido (uso manual via curl
// pra teste). Sem isso, qualquer um com a URL pode disparar mensagem pelo
// número oficial da empresa — não usar em fluxo de produção sem autenticação.

import { iniciarCronometro, log } from "../_shared/logger.ts";

const FUNCAO = "whatsapp-send";
const GRAPH_API_VERSION = "v21.0";
const MAX_MESSAGE_LENGTH = 4096;

// Sem Access-Control-Allow-Origin de propósito: com verify_jwt=false, um
// wildcard "*" permitiria qualquer página web disparar envio via navegador.
// Sem esse header o preflight falha e só curl/servidor conseguem chamar.
const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

interface SendBody {
  to: string;
  message: string;
}

function parseBody(raw: unknown): SendBody | null {
  if (!raw || typeof raw !== "object") return null;
  const to = (raw as Record<string, unknown>).to;
  const message = (raw as Record<string, unknown>).message;
  if (typeof to !== "string" || typeof message !== "string") return null;

  const toDigits = to.replace(/\D/g, "");
  if (toDigits.length < 8 || toDigits.length > 15) return null;
  if (message.trim().length === 0 || message.length > MAX_MESSAGE_LENGTH) return null;

  return { to: toDigits, message };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);
  }

  const cron = iniciarCronometro();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ ok: false, erro: "json_invalido" }, 400);
  }

  const body = parseBody(raw);
  if (!body) {
    return jsonResponse(
      { ok: false, erro: "payload_invalido", detalhe: "esperado { to: string, message: string }" },
      400,
    );
  }

  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  const accessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  if (!phoneNumberId || !accessToken) {
    log({ funcao: FUNCAO, evento: "secrets_ausentes", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "configuracao_ausente" }, 500);
  }

  let metaResponse: Response;
  try {
    metaResponse = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: body.to,
          type: "text",
          text: { preview_url: false, body: body.message },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    log({
      funcao: FUNCAO,
      evento: timedOut ? "timeout_meta" : "fetch_falhou",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: err instanceof Error ? err.message : "erro_desconhecido",
    });
    return jsonResponse({ ok: false, erro: timedOut ? "timeout_meta" : "falha_ao_chamar_meta" }, 502);
  }

  const metaBody = await metaResponse.json().catch(() => null);

  log({
    funcao: FUNCAO,
    evento: "envio_tentado",
    status: metaResponse.ok ? "ok" : "erro",
    duracao_ms: cron(),
    extra: { meta_status: metaResponse.status },
  });

  return jsonResponse(
    { ok: metaResponse.ok, meta_status: metaResponse.status, meta_body: metaBody },
    metaResponse.ok ? 200 : metaResponse.status,
  );
});
