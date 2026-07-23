// Edge Function: whatsapp-register
// Endpoint de TESTE, uso único: registra o número no WhatsApp Cloud API
// (POST /{phone_number_id}/register) — passo obrigatório da Meta antes do
// número poder enviar mensagem (erro 133010 "Account not registered" sem isso).
//
// De propósito NÃO aceita nada no corpo da requisição: phone_number_id, token
// e PIN vêm só de env (WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN,
// WHATSAPP_REGISTER_PIN). Isso evita que, com verify_jwt=false, alguém de fora
// consiga trocar o PIN de registro do número chamando esse endpoint com outro
// valor — só dispara sempre a mesma chamada fixa.
//
// TEMPORÁRIO: depois que o registro for confirmado (uma vez só, normalmente),
// não há motivo pra manter esse endpoint no ar — considerar deletar.

import { iniciarCronometro, log } from "../_shared/logger.ts";

const FUNCAO = "whatsapp-register";
const GRAPH_API_VERSION = "v21.0";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);
  }

  const cron = iniciarCronometro();

  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  const accessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const pin = Deno.env.get("WHATSAPP_REGISTER_PIN");
  if (!phoneNumberId || !accessToken || !pin) {
    log({ funcao: FUNCAO, evento: "secrets_ausentes", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "configuracao_ausente" }, 500);
  }

  let metaResponse: Response;
  try {
    metaResponse = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/register`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messaging_product: "whatsapp", pin }),
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
    evento: "registro_tentado",
    status: metaResponse.ok ? "ok" : "erro",
    duracao_ms: cron(),
    extra: { meta_status: metaResponse.status },
  });

  return jsonResponse(
    { ok: metaResponse.ok, meta_status: metaResponse.status, meta_body: metaBody },
    metaResponse.ok ? 200 : metaResponse.status,
  );
});
