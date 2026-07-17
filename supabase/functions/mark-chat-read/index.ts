// Edge Function: mark-chat-read
// Marca a conversa como lida no WhatsApp (dispara a confirmação de leitura,
// o "tique azul") quando o atendente ABRE uma conversa que está atendendo.
//
// Contrato com o frontend:
//   POST { atendimento_id: string }
//
// Regra de negócio (combinada com o produto):
//   O azul SÓ pode aparecer quando quem abriu é o atendente responsável E o
//   atendimento está em andamento. Ou seja:
//     - Pré-visualizar na lista NÃO marca como lido.
//     - Admin/supervisor apenas espiando (sem ser o assigned_to) NÃO marca.
//   Por isso a autorização aqui é ESTRITA: assigned_to === auth.uid()
//   E status === 'em_atendimento'. Não há bypass de superadmin/permissão —
//   diferente do send-whatsapp-message, pois aqui "poder ver" ≠ "deve marcar".
//
// Idempotente: marcar um chat já lido é no-op no WhatsApp.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { marcarChatComoLido, ZapiError } from "../_shared/uazapi-client.ts";

const FUNCAO = "mark-chat-read";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Payload {
  atendimento_id?: string;
}

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

  // 1) Autenticação: JWT do atendente.
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!jwt) {
    log({ funcao: FUNCAO, evento: "sem_token", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }

  const { data: userRes, error: errUser } = await supabase.auth.getUser(jwt);
  if (errUser || !userRes?.user) {
    log({
      funcao: FUNCAO,
      evento: "token_invalido",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: errUser?.message,
    });
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }
  const userId = userRes.user.id;

  // 2) Payload.
  let payload: Payload;
  try {
    payload = (await req.json()) as Payload;
  } catch {
    return jsonResponse({ ok: false, erro: "payload_invalido" }, 400);
  }
  const atendimentoId = payload.atendimento_id?.trim();
  if (!atendimentoId) {
    return jsonResponse(
      { ok: false, erro: "campos_obrigatorios", detalhe: "atendimento_id é obrigatório" },
      400,
    );
  }

  // 3) Carrega atendimento + número do cliente.
  const { data: atend, error: errAtend } = await supabase
    .from("atendimentos")
    .select("id, assigned_to, status, client_id, clients:client_id(numero_whatsapp)")
    .eq("id", atendimentoId)
    .maybeSingle();

  if (errAtend) {
    log({
      funcao: FUNCAO,
      evento: "leitura_atendimento",
      status: "erro",
      atendimento_id: atendimentoId,
      duracao_ms: cron(),
      erro_msg: errAtend.message,
    });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
  if (!atend) {
    return jsonResponse({ ok: false, erro: "atendimento_nao_encontrado" }, 404);
  }

  // 4) Autorização ESTRITA: só o responsável pode marcar como lido.
  if (atend.assigned_to !== userId) {
    log({
      funcao: FUNCAO,
      evento: "forbidden",
      status: "erro",
      atendimento_id: atendimentoId,
      duracao_ms: cron(),
    });
    return jsonResponse({ ok: false, erro: "forbidden" }, 403);
  }

  // 5) Só marca quando de fato está atendendo (não em triagem/reservado/encerrado).
  if (atend.status !== "em_atendimento") {
    log({
      funcao: FUNCAO,
      evento: "nao_elegivel",
      status: "ok",
      atendimento_id: atendimentoId,
      duracao_ms: cron(),
      extra: { status: atend.status },
    });
    return jsonResponse({ ok: true, marcado: false, motivo: "nao_em_atendimento" });
  }

  const numeroWhatsapp = (atend as { clients?: { numero_whatsapp?: string } }).clients
    ?.numero_whatsapp?.replace(/\D/g, "");
  if (!numeroWhatsapp) {
    return jsonResponse({ ok: false, erro: "cliente_sem_numero" }, 422);
  }

  // 6) Marca como lido na uazapi em background (resposta rápida ao front).
  const tarefa = (async () => {
    const t = iniciarCronometro();
    try {
      await marcarChatComoLido(numeroWhatsapp);
      log({
        funcao: FUNCAO,
        evento: "marcado_lido",
        status: "ok",
        atendimento_id: atendimentoId,
        duracao_ms: t(),
      });
    } catch (err) {
      log({
        funcao: FUNCAO,
        evento: "marcar_lido_falha",
        status: "erro",
        atendimento_id: atendimentoId,
        duracao_ms: t(),
        erro_msg: err instanceof Error ? err.message : String(err),
        extra: { zapi_status: err instanceof ZapiError ? err.status : null },
      });
    }
  })();

  const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (edge?.waitUntil) {
    edge.waitUntil(tarefa);
  } else {
    tarefa.catch(() => {});
  }

  return jsonResponse({ ok: true, marcado: true });
});
