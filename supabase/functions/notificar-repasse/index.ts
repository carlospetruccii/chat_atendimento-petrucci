// Edge Function: notificar-repasse
// Avisa no WhatsApp PESSOAL do colaborador que um atendimento foi
// repassado/atribuído a ele.
//
// DOIS caminhos de entrada, ambos convergindo no mesmo envio idempotente:
//
//  A) INTERNO (recomendado / robusto): disparado por um trigger no banco
//     (net.http_post) logo que o evento de repasse é gravado. Autenticado por
//     `x-internal-secret` (segredo em public.app_secrets, RLS deny-all).
//     Payload: { timeline_event_id }. Não depende do navegador.
//
//  B) USUÁRIO (legado / redundante): chamado pelo frontend após o repasse.
//     Autenticado pelo JWT de quem repassou. Payload: { atendimento_id,
//     to_user_id }. Exige um evento de repasse recente (janela de 2 min).
//
// Idempotência: o claim atômico em timeline_events.notificacao_repasse_enviada_at
// garante NO MÁXIMO 1 aviso por evento, mesmo se os dois caminhos rodarem.
//
// SECURITY: nunca envia para número vindo do payload — o destino é sempre
// resolvido do cadastro do colaborador (users.whatsapp).

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { registrarEnvioInterno } from "../_shared/envio-interno.ts";
import { enviarTexto } from "../_shared/uazapi-client.ts";
import { montarMensagem } from "../_shared/formato.ts";

const FUNCAO = "notificar-repasse";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Janela em que um evento de repasse/atribuição é considerado "recente" (modo B).
const JANELA_EVENTO_MS = 2 * 60 * 1000;

const TIPOS_EVENTO = ["repassado", "reservado"];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function extrairObservacao(payload: unknown): string | null {
  const obs = (payload as { observacao?: unknown } | null)?.observacao;
  return typeof obs === "string" && obs.trim() ? obs.trim() : null;
}

// deno-lint-ignore no-explicit-any
type Supa = any;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);
  }

  const cron = iniciarCronometro();
  const supabase: Supa = getSupabaseAdmin();

  // Contexto resolvido pelos dois modos:
  let atendimentoId: string | undefined;
  let toUserId: string | undefined;
  let callerId: string | undefined; // ator (quem repassou)
  let eventoId: string | undefined; // linha a ser reivindicada (claim)
  let observacao: string | null = null;

  const internalSecret = (req.headers.get("x-internal-secret") ?? "").trim();

  if (internalSecret) {
    // ---------- MODO A: INTERNO (trigger) ----------
    const { data: secretRow } = await supabase
      .from("app_secrets")
      .select("value")
      .eq("key", "repasse_internal")
      .maybeSingle();
    const esperado = (secretRow?.value as string | undefined) ?? "";
    if (!esperado || internalSecret !== esperado) {
      log({ funcao: FUNCAO, evento: "internal_secret_invalido", status: "erro", duracao_ms: cron() });
      return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
    }

    let payload: { timeline_event_id?: string };
    try {
      payload = (await req.json()) as { timeline_event_id?: string };
    } catch {
      return jsonResponse({ ok: false, erro: "payload_invalido" }, 400);
    }
    eventoId = payload.timeline_event_id?.trim();
    if (!eventoId) {
      return jsonResponse(
        { ok: false, erro: "campos_obrigatorios", detalhe: "timeline_event_id é obrigatório" },
        400,
      );
    }

    const { data: ev } = await supabase
      .from("timeline_events")
      .select("id, atendimento_id, actor_user_id, target_user_id, tipo_evento, payload")
      .eq("id", eventoId)
      .maybeSingle();

    // Respostas genéricas ({ ok: true }) para não virarem oráculo de enumeração.
    if (!ev) return jsonResponse({ ok: true });
    if (
      !TIPOS_EVENTO.includes(ev.tipo_evento as string) ||
      !ev.target_user_id ||
      !ev.actor_user_id ||
      ev.actor_user_id === ev.target_user_id
    ) {
      return jsonResponse({ ok: true });
    }

    atendimentoId = ev.atendimento_id as string;
    toUserId = ev.target_user_id as string;
    callerId = ev.actor_user_id as string;
    observacao = extrairObservacao(ev.payload);
  } else {
    // ---------- MODO B: USUÁRIO (frontend) ----------
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
      log({ funcao: FUNCAO, evento: "token_invalido", status: "erro", duracao_ms: cron(), erro_msg: errUser?.message });
      return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
    }
    callerId = userRes.user.id;

    let payload: { atendimento_id?: string; to_user_id?: string };
    try {
      payload = (await req.json()) as { atendimento_id?: string; to_user_id?: string };
    } catch {
      return jsonResponse({ ok: false, erro: "payload_invalido" }, 400);
    }
    atendimentoId = payload.atendimento_id?.trim();
    toUserId = payload.to_user_id?.trim();
    if (!atendimentoId || !toUserId) {
      return jsonResponse(
        { ok: false, erro: "campos_obrigatorios", detalhe: "atendimento_id e to_user_id são obrigatórios" },
        400,
      );
    }
    if (toUserId === callerId) {
      return jsonResponse({ ok: true, skipped: "auto_atribuicao" });
    }
  }

  const skip = (motivo: string): Response => {
    log({ funcao: FUNCAO, evento: motivo, status: "ok", atendimento_id: atendimentoId, duracao_ms: cron() });
    return jsonResponse({ ok: true });
  };

  // ---------- Fluxo compartilhado ----------
  const { data: atend, error: errAtend } = await supabase
    .from("atendimentos")
    .select(
      "id, assigned_to, current_department_id, clients:client_id(nome, numero_whatsapp), departments:current_department_id(nome)",
    )
    .eq("id", atendimentoId)
    .maybeSingle();

  if (errAtend) {
    log({ funcao: FUNCAO, evento: "leitura_atendimento", status: "erro", atendimento_id: atendimentoId, duracao_ms: cron(), erro_msg: errAtend.message });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
  if (!atend) return skip("atendimento_nao_encontrado");

  // Só notifica se o colaborador realmente detém o atendimento agora.
  if (atend.assigned_to !== toUserId) return skip("assigned_to_divergente");

  // MODO B: resolve o evento recente (autor = chamador) para o claim.
  if (!eventoId) {
    const desdeIso = new Date(Date.now() - JANELA_EVENTO_MS).toISOString();
    const { data: evento } = await supabase
      .from("timeline_events")
      .select("id, payload")
      .eq("atendimento_id", atendimentoId)
      .eq("target_user_id", toUserId)
      .eq("actor_user_id", callerId)
      .in("tipo_evento", TIPOS_EVENTO)
      .gte("created_at", desdeIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!evento) return skip("sem_evento_recente");
    eventoId = evento.id as string;
    observacao = extrairObservacao(evento.payload);
  }

  // WhatsApp pessoal do colaborador. Sem número → no-op.
  const { data: destino, error: errDestino } = await supabase
    .from("users")
    .select("nome, whatsapp, ativo, is_system_user")
    .eq("id", toUserId)
    .maybeSingle();

  if (errDestino) return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  if (!destino || destino.ativo === false || destino.is_system_user === true) {
    return skip("destino_invalido");
  }
  const numeroDestino = (destino.whatsapp ?? "").replace(/\D/g, "");
  if (!numeroDestino) return skip("destino_sem_whatsapp");

  // Idempotência: claim atômico via INSERT no ledger (timeline_events é
  // append-only, então NÃO dá pra usar UPDATE de coluna lá). Quem insere
  // primeiro envia; conflito (já existe) → já foi notificado.
  const { data: claimIns, error: errClaim } = await supabase
    .from("repasse_notificacoes")
    .upsert({ timeline_event_id: eventoId }, { onConflict: "timeline_event_id", ignoreDuplicates: true })
    .select("timeline_event_id");

  if (errClaim) {
    // Nunca mais falhar em silêncio: propaga o erro do claim.
    log({ funcao: FUNCAO, evento: "claim_erro", status: "erro", atendimento_id: atendimentoId, duracao_ms: cron(), erro_msg: errClaim.message });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
  if (!claimIns || claimIns.length === 0) return skip("ja_notificado");

  const { data: ator } = await supabase
    .from("users")
    .select("nome")
    .eq("id", callerId)
    .maybeSingle();

  const cliente = (atend as { clients?: { nome?: string | null; numero_whatsapp?: string } }).clients;
  const departamento = (atend as { departments?: { nome?: string | null } }).departments;
  const clienteNome = cliente?.nome?.trim() || cliente?.numero_whatsapp || "Cliente";

  const mensagem = montarMensagem({
    clienteNome,
    departamentoNome: departamento?.nome?.trim() || null,
    atorNome: ator?.nome?.trim() || null,
    observacao,
    appUrl: Deno.env.get("APP_URL")?.trim() || null,
  });

  // Envio em background — o aviso não pode segurar/quebrar o repasse.
  const tarefa = (async () => {
    const t = iniciarCronometro();
    try {
      const resp = await enviarTexto({ telefone: numeroDestino, mensagem });
      // Aviso interno: marca para o webhook não gravar o eco na conversa.
      await registrarEnvioInterno(FUNCAO, resp);
      log({ funcao: FUNCAO, evento: "aviso_enviado", status: "ok", atendimento_id: atendimentoId, duracao_ms: t() });
    } catch (err) {
      // Solta o claim para permitir nova tentativa (ex.: caminho redundante do front).
      await supabase.from("repasse_notificacoes").delete().eq("timeline_event_id", eventoId);
      log({
        funcao: FUNCAO,
        evento: "aviso_falha",
        status: "erro",
        atendimento_id: atendimentoId,
        duracao_ms: t(),
        erro_msg: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (edge?.waitUntil) edge.waitUntil(tarefa);
  else tarefa.catch(() => {});

  return jsonResponse({ ok: true, notificado: true });
});
