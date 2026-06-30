// Edge Function: send-whatsapp-audio
// Recebe áudio gravado pelo atendente, faz upload no bucket privado
// `mensagens-midia/outbound/{atendimento_id}/{uuid}.ogg`, insere a mensagem
// (tipo='audio', status_envio='aguardando_envio') e dispara envio via Z-API
// como **PTT (voice note)**, usando data URI com mime audio/ogg;codecs=opus.
//
// Contrato:
//   POST { atendimento_id, audio_base64, mime_type, duracao_seg }
//   → { ok, mensagem_id, status_envio }

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { enviarMidia, ZapiError } from "../_shared/zapi-client.ts";

const FUNCAO = "send-whatsapp-audio";
const BUCKET = "mensagens-midia";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Payload {
  atendimento_id?: string;
  audio_base64?: string;
  mime_type?: string;
  duracao_seg?: number;
  reply_to_message_id?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function motivoLegivel(err: unknown): string {
  if (err instanceof ZapiError) {
    if (err.status === 429) return "Z-API indisponível (limite de requisições)";
    if (err.status === 401 || err.status === 403) return "Z-API recusou a credencial";
    if (err.status >= 500) return "Z-API indisponível";
    try {
      const j = JSON.parse(err.body) as { error?: string; message?: string };
      const msg = j.error ?? j.message;
      if (msg && typeof msg === "string") return msg.slice(0, 140);
    } catch {
      // ignore
    }
    return `Erro Z-API (HTTP ${err.status})`;
  }
  if (err instanceof Error) return err.message.slice(0, 140);
  return "Falha desconhecida no envio";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // 1) Auth
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!jwt) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  const { data: userRes, error: errUser } = await supabase.auth.getUser(jwt);
  if (errUser || !userRes?.user) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  const userId = userRes.user.id;

  // 2) Parse
  let payload: Payload;
  try {
    payload = (await req.json()) as Payload;
  } catch {
    return jsonResponse({ ok: false, erro: "payload_invalido" }, 400);
  }
  const atendimentoId = payload.atendimento_id?.trim();
  const audioBase64 = payload.audio_base64;
  const mimeType = (payload.mime_type ?? "audio/webm").trim();
  const duracaoSeg = Math.max(0, Math.floor(payload.duracao_seg ?? 0));
  const replyToMessageId = payload.reply_to_message_id?.trim() || null;
  if (!atendimentoId || !audioBase64) {
    return jsonResponse({ ok: false, erro: "campos_obrigatorios" }, 400);
  }

  // 3) Atendimento + cliente
  const { data: atend, error: errAtend } = await supabase
    .from("atendimentos")
    .select(
      "id, assigned_to, current_department_id, client_id, clients:client_id(numero_whatsapp)",
    )
    .eq("id", atendimentoId)
    .maybeSingle();
  if (errAtend) return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  if (!atend) return jsonResponse({ ok: false, erro: "atendimento_nao_encontrado" }, 404);

  // 4) Autorização
  let autorizado = atend.assigned_to === userId;
  if (!autorizado) {
    const [{ data: userRow }, { data: permRow }] = await Promise.all([
      supabase.from("users").select("is_superadmin").eq("id", userId).maybeSingle(),
      supabase
        .from("user_permissions")
        .select("permission")
        .eq("user_id", userId)
        .eq("permission", "force_close")
        .maybeSingle(),
    ]);
    if (userRow?.is_superadmin || permRow) autorizado = true;
  }
  if (!autorizado) return jsonResponse({ ok: false, erro: "forbidden" }, 403);

  const numeroWhatsapp = (atend as { clients?: { numero_whatsapp?: string } }).clients
    ?.numero_whatsapp?.replace(/\D/g, "");
  if (!numeroWhatsapp) return jsonResponse({ ok: false, erro: "cliente_sem_numero" }, 422);

  // 5) Upload no bucket privado
  const bytes = decodeBase64(audioBase64);
  const uuid = crypto.randomUUID();
  const storagePath = `outbound/${atendimentoId}/${uuid}.ogg`;
  const { error: errUp } = await supabase.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: "audio/ogg",
    upsert: false,
  });
  if (errUp) {
    log({
      funcao: FUNCAO,
      evento: "upload_falhou",
      status: "erro",
      atendimento_id: atendimentoId,
      duracao_ms: cron(),
      erro_msg: errUp.message,
    });
    return jsonResponse({ ok: false, erro: "upload_falhou" }, 500);
  }

  // 5b) Signed URL longa para satisfazer mensagens_media_url_chk e dar link auditável
  const { data: signed } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, 60 * 60 * 24 * 365 * 10);
  const mediaUrlSigned = signed?.signedUrl ?? `storage://${BUCKET}/${storagePath}`;

  // 6) INSERT mensagem
  const mediaMetadata = {
    storage_path: storagePath,
    duracao_seg: duracaoSeg,
    mime_type: mimeType,
  };
  const { data: inserted, error: errIns } = await supabase
    .from("mensagens")
    .insert({
      atendimento_id: atendimentoId,
      client_id: atend.client_id,
      department_id: atend.current_department_id,
      direction: "outbound",
      sender_type: "atendente",
      sent_by_user_id: userId,
      tipo: "audio",
      content: null,
      media_url: mediaUrlSigned,
      media_metadata: mediaMetadata,
      status_envio: "enviando",
      reply_to_message_id: replyToMessageId,
    })
    .select("id")
    .single();
  if (errIns || !inserted) {
    log({
      funcao: FUNCAO,
      evento: "insert_falhou",
      status: "erro",
      atendimento_id: atendimentoId,
      duracao_ms: cron(),
      erro_msg: errIns?.message,
    });
    return jsonResponse({ ok: false, erro: "insert_falhou" }, 500);
  }
  const mensagemId = inserted.id as string;

  log({
    funcao: FUNCAO,
    evento: "envio_iniciado",
    status: "ok",
    atendimento_id: atendimentoId,
    mensagem_id: mensagemId,
    duracao_ms: cron(),
  });

  // 7) Background: chama Z-API com data URI ogg (PTT)
  const tarefaEnvio = (async () => {
    const t = iniciarCronometro();
    try {
      let quotedZapiMessageId: string | undefined;
      if (replyToMessageId) {
        const { data: quoted } = await supabase
          .from("mensagens")
          .select("zapi_message_id")
          .eq("id", replyToMessageId)
          .maybeSingle();
        if (quoted?.zapi_message_id) quotedZapiMessageId = quoted.zapi_message_id as string;
      }
      const dataUri = `data:audio/ogg;codecs=opus;base64,${audioBase64}`;
      const respostaZapi = await enviarMidia({
        telefone: numeroWhatsapp,
        tipo: "audio",
        url: dataUri,
        quotedZapiMessageId,
      });
      const zapiMessageId =
        (respostaZapi as { messageId?: string; id?: string } | null)?.messageId ??
          (respostaZapi as { id?: string } | null)?.id ??
          null;

      const { error: errUpd } = await supabase
        .from("mensagens")
        .update({ status_envio: "enviado", zapi_message_id: zapiMessageId })
        .eq("id", mensagemId);

      if (errUpd) {
        log({
          funcao: FUNCAO,
          evento: "update_pos_envio",
          status: "erro",
          atendimento_id: atendimentoId,
          mensagem_id: mensagemId,
          duracao_ms: t(),
          erro_msg: errUpd.message,
        });
        return;
      }

      log({
        funcao: FUNCAO,
        evento: "envio_sucesso",
        status: "ok",
        atendimento_id: atendimentoId,
        mensagem_id: mensagemId,
        duracao_ms: t(),
      });
    } catch (err) {
      const motivo = motivoLegivel(err);
      const novoMeta = { ...mediaMetadata, erro_motivo: motivo };
      await supabase
        .from("mensagens")
        .update({ status_envio: "falha", media_metadata: novoMeta })
        .eq("id", mensagemId);

      log({
        funcao: FUNCAO,
        evento: "envio_falha",
        status: "erro",
        atendimento_id: atendimentoId,
        mensagem_id: mensagemId,
        duracao_ms: t(),
        erro_msg: motivo,
        extra: { zapi_status: err instanceof ZapiError ? err.status : null },
      });
    }
  })();

  const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (edge?.waitUntil) edge.waitUntil(tarefaEnvio);
  else tarefaEnvio.catch(() => {});

  return jsonResponse({ ok: true, mensagem_id: mensagemId, status_envio: "enviando" });
});
