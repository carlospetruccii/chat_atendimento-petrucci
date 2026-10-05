// Edge Function: docs-conexao
// Backend da seção "Conexão do número financeiro" na aba Docs de Configurações.
// Só ADMIN.
//
// Contrato:
//   POST { action: "status" }
//     → { ok, connected, loggedIn, status, profileName, numero, webhook_configurado }
//   POST { action: "enviar_teste", numero }  → { ok, enviado }  (teste ponta a ponta)
//   POST { action: "webhook_setup" }
//     → { ok, criado, ja_existia, webhook_configurado }
//
// De propósito NÃO existe conectar/QR/desconectar aqui: o número financeiro é
// do outro sistema da Almore, que dispara documentos por ele. Desconectar daqui
// derrubaria esse sistema.
//
// O webhook é ADICIONADO (`action: "add"`) ao lado de qualquer webhook que já
// exista na instância — o do outro sistema, se houver, fica intocado. A lista
// de webhooks da instância nunca é devolvida à tela (tem URL de terceiro).

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import {
  enviarTexto,
  extrairMessageId,
  garantirWebhookAdicional,
  statusInstancia,
  UazapiError,
  verWebhook,
} from "../_shared/uazapi-client.ts";
import { exigirAcessoDocs, usuarioDoJwt } from "../_shared/docs-acesso.ts";

const FUNCAO = "docs-conexao";
const EVENTOS = ["messages", "messages_update", "connection"];

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

function comparaConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Chamada de operação (CLI), sem login de admin: header `x-docs-setup-token`
 * igual ao secret DOCS_SETUP_TOKEN. O secret só existe enquanto alguém está
 * configurando — é criado, usado e apagado na hora. Sem ele, só admin logado.
 */
function chamadaInterna(req: Request): boolean {
  const esperado = Deno.env.get("DOCS_SETUP_TOKEN");
  const recebido = req.headers.get("x-docs-setup-token") ?? "";
  return !!esperado && esperado.length >= 32 && comparaConstante(recebido, esperado);
}

function urlWebhookDocs(): string | null {
  const base = Deno.env.get("SUPABASE_URL");
  return base ? `${base.replace(/\/+$/, "")}/functions/v1/webhook-docs-receive` : null;
}

async function webhookConfigurado(url: string): Promise<boolean> {
  const atuais = await verWebhook("financeiro");
  const lista = Array.isArray(atuais)
    ? atuais
    : (() => {
      const o = (atuais ?? {}) as Record<string, unknown>;
      const cand = o.webhooks ?? o.data ?? o.items;
      return Array.isArray(cand) ? cand : (o.url ? [o] : []);
    })();
  return (lista as unknown[]).some((w) => {
    const o = (w ?? {}) as Record<string, unknown>;
    return typeof o.url === "string" && o.url.trim() === url && o.enabled !== false;
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();
  // Operação via CLI com token temporário (ver chamadaInterna) ou admin logado.
  if (!chamadaInterna(req)) {
    const userId = await usuarioDoJwt(supabase, req);
    if (!userId) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
    const membro = await exigirAcessoDocs(supabase, userId);
    if (!membro?.isSuperadmin) return jsonResponse({ ok: false, erro: "forbidden" }, 403);
  }

  if (!Deno.env.get("UAZAPI_TOKEN_FINANCEIRO")) {
    return jsonResponse({ ok: false, erro: "credenciais_ausentes" });
  }
  const url = urlWebhookDocs();
  if (!url) return jsonResponse({ ok: false, erro: "supabase_url_ausente" }, 500);

  let action = "status";
  let corpo: Record<string, unknown> = {};
  try {
    corpo = (await req.json()) as Record<string, unknown>;
    if (typeof corpo.action === "string") action = corpo.action;
  } catch {
    // corpo vazio = status
  }

  try {
    if (action === "status") {
      const [st, configurado] = await Promise.all([
        statusInstancia("financeiro"),
        webhookConfigurado(url),
      ]);
      return jsonResponse({
        ok: true,
        connected: st.connected,
        loggedIn: st.loggedIn,
        status: st.status ?? null,
        profileName: st.profileName ?? null,
        numero: st.numero ?? null,
        webhook_configurado: configurado,
      });
    }

    if (action === "webhook_setup") {
      const r = await garantirWebhookAdicional({ url, events: EVENTOS, instancia: "financeiro" });
      log({
        funcao: FUNCAO,
        evento: "webhook_docs_garantido",
        status: "ok",
        duracao_ms: cron(),
        extra: { criado: r.criado, ja_existia: r.ja_existia },
      });
      return jsonResponse({ ok: true, ...r, webhook_configurado: await webhookConfigurado(url) });
    }

    // Teste de ponta a ponta: manda uma mensagem pelo número financeiro para um
    // número informado (ex.: o celular de quem está testando). A resposta dessa
    // pessoa entra na aba Docs e dispara a resposta automática.
    if (action === "enviar_teste") {
      const numero = typeof corpo.numero === "string" ? corpo.numero.replace(/\D/g, "") : "";
      if (!/^[1-9]\d{9,14}$/.test(numero)) {
        return jsonResponse({ ok: false, erro: "numero_invalido" }, 400);
      }
      const resp = await enviarTexto({
        telefone: numero,
        mensagem: "Teste da aba Docs (número financeiro). Pode responder esta mensagem.",
        instancia: "financeiro",
      });
      log({ funcao: FUNCAO, evento: "teste_enviado", status: "ok", duracao_ms: cron() });
      return jsonResponse({ ok: true, enviado: !!extrairMessageId(resp) });
    }

    return jsonResponse({ ok: false, erro: "acao_invalida" }, 400);
  } catch (err) {
    log({
      funcao: FUNCAO,
      evento: "erro_uazapi",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: err instanceof Error ? err.message.slice(0, 200) : String(err),
      extra: { action, uazapi_status: err instanceof UazapiError ? err.status : null },
    });
    return jsonResponse({ ok: false, erro: "falha_uazapi" });
  }
});
