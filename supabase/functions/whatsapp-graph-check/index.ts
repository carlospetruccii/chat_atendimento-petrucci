// Edge Function: whatsapp-graph-check
// Endpoint de TESTE, diagnóstico único: faz 4 GETs fixos na Graph API pra
// checar status de registro/qualidade dos números e das WABAs envolvidas na
// migração de coexistência (debug do erro 133010 "Account not registered").
//
// De propósito NÃO aceita nenhum input (nem query, nem body): os 4 endpoints
// são constantes no código. Só lê WHATSAPP_ACCESS_TOKEN do env. Isso evita
// que, com verify_jwt=false, alguém de fora use esse endpoint como proxy pra
// consultar qualquer outro objeto da Graph API com nosso token.
//
// TEMPORÁRIO: é só diagnóstico pontual — deletar depois de resolver o 133010.

import { iniciarCronometro, log } from "../_shared/logger.ts";

const FUNCAO = "whatsapp-graph-check";
const GRAPH_API_VERSION = "v21.0";

const PHONE_FIELDS =
  "id,display_phone_number,verified_name,platform_type,account_mode,code_verification_status,quality_rating,status";
const WABA_FIELDS = "id,name,account_review_status,business_verification_status,health_status";

const CHECKS = [
  { label: "phone_numbers_992707320029708", path: `992707320029708/phone_numbers?fields=${PHONE_FIELDS}` },
  { label: "phone_numbers_2252568502218199", path: `2252568502218199/phone_numbers?fields=${PHONE_FIELDS}` },
  { label: "waba_992707320029708", path: `992707320029708?fields=${WABA_FIELDS}` },
  { label: "waba_2252568502218199", path: `2252568502218199?fields=${WABA_FIELDS}` },
] as const;

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

async function runCheck(
  label: string,
  path: string,
  accessToken: string,
): Promise<{ label: string; status: number | null; body: unknown; erro?: string }> {
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => null);
    return { label, status: res.status, body };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return { label, status: null, body: null, erro: timedOut ? "timeout_meta" : "falha_ao_chamar_meta" };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);
  }

  const cron = iniciarCronometro();

  const accessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  if (!accessToken) {
    log({ funcao: FUNCAO, evento: "secrets_ausentes", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "configuracao_ausente" }, 500);
  }

  const resultados = await Promise.all(
    CHECKS.map((c) => runCheck(c.label, c.path, accessToken)),
  );

  log({
    funcao: FUNCAO,
    evento: "checks_executados",
    status: "ok",
    duracao_ms: cron(),
    extra: { total: resultados.length },
  });

  return jsonResponse({ ok: true, resultados });
});
