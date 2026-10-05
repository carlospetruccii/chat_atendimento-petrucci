// Edge Function: send-whatsapp-media
// Envia imagem, vídeo ou documento anexado pelo atendente.
// Faz upload no bucket privado `mensagens-midia/outbound/{atendimento_id}/{uuid}.{ext}`,
// gera signed URL longa, insere mensagem (status_envio='enviando') e dispara
// envio via Z-API em background (waitUntil).
//
// Contrato:
//   POST { atendimento_id, tipo: "image"|"video"|"document",
//          arquivo_base64, mime_type, nome_arquivo, caption? }
//   → { ok, mensagem_id, status_envio }

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { atualizacaoAposErroEnvio } from "../_shared/erro-envio.ts";
import { gravarIdPosEnvio } from "../_shared/pos-envio.ts";
import { enviarMidia, extrairMessageId, ZapiError, type TipoMidia } from "../_shared/uazapi-client.ts";

const FUNCAO = "send-whatsapp-media";
const BUCKET = "mensagens-midia";
const MAX_BYTES = 16 * 1024 * 1024; // 16 MB (limite Z-API)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Payload {
  atendimento_id?: string;
  tipo?: string;
  arquivo_base64?: string;
  mime_type?: string;
  nome_arquivo?: string;
  caption?: string;
  reply_to_message_id?: string;
}

const TIPOS_ACEITOS: ReadonlySet<TipoMidia> = new Set(["image", "video", "document"]);

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

function extDoArquivo(nome: string, mime: string): string {
  const m = nome.match(/\.([a-zA-Z0-9]{1,8})$/);
  if (m) return m[1].toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "application/pdf": "pdf",
  };
  return map[mime] ?? "bin";
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
  const tipo = (payload.tipo ?? "").trim() as TipoMidia;
  const arquivoB64 = payload.arquivo_base64;
  const mimeType = (payload.mime_type ?? "application/octet-stream").trim();
  const nomeArquivo = (payload.nome_arquivo ?? "arquivo").trim().slice(0, 200);
  const caption = payload.caption?.trim().slice(0, 1024) || null;
  const replyToMessageId = payload.reply_to_message_id?.trim() || null;

  if (!atendimentoId || !arquivoB64 || !TIPOS_ACEITOS.has(tipo)) {
    return jsonResponse({ ok: false, erro: "campos_obrigatorios" }, 400);
  }

  // Tamanho aprox: base64 → 3/4. Validação cedo.
  if ((arquivoB64.length * 3) / 4 > MAX_BYTES + 1024) {
    return jsonResponse({ ok: false, erro: "arquivo_muito_grande" }, 413);
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

  // 5) Upload
  const bytes = decodeBase64(arquivoB64);
  if (bytes.byteLength > MAX_BYTES) {
    return jsonResponse({ ok: false, erro: "arquivo_muito_grande" }, 413);
  }
  const ext = extDoArquivo(nomeArquivo, mimeType);
  const uuid = crypto.randomUUID();
  const storagePath = `outbound/${atendimentoId}/${uuid}.${ext}`;
  const { error: errUp } = await supabase.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: mimeType,
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

  // 5b) Signed URL (10 anos) — satisfaz mensagens_media_url_chk e dá link auditável.
  const { data: signed } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, 60 * 60 * 24 * 365 * 10);
  const mediaUrlSigned = signed?.signedUrl ?? `storage://${BUCKET}/${storagePath}`;

  // 6) INSERT mensagem
  const mediaMetadata = {
    storage_path: storagePath,
    mime_type: mimeType,
    file_name: nomeArquivo,
    extensao: ext,
  };
  const tipoEnum = tipo === "image" ? "imagem" : tipo === "document" ? "documento" : "video";
  const { data: inserted, error: errIns } = await supabase
    .from("mensagens")
    .insert({
      atendimento_id: atendimentoId,
      client_id: atend.client_id,
      department_id: atend.current_department_id,
      direction: "outbound",
      sender_type: "atendente",
      sent_by_user_id: userId,
      tipo: tipoEnum,
      content: caption,
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

  // 7) Background: chama Z-API com data URI base64
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
      const respostaUazapi = await enviarMidia({
        telefone: numeroWhatsapp,
        tipo,
        url: mediaUrlSigned,
        caption: caption ?? undefined,
        fileName: tipo === "document" ? nomeArquivo : undefined,
        extension: tipo === "document" ? ext : undefined,
        quotedZapiMessageId,
      });
      const zapiMessageId = extrairMessageId(respostaUazapi);

      const posEnvio = await gravarIdPosEnvio({
        supabase,
        tabela: "mensagens",
        colunaMessageId: "zapi_message_id",
        mensagemId,
        messageId: zapiMessageId,
      });
      if (posEnvio.conflito && posEnvio.ok) {
        log({
          funcao: FUNCAO,
          evento: "update_pos_envio_conflito_eco",
          status: "ok",
          atendimento_id: atendimentoId,
          mensagem_id: mensagemId,
        });
      }

      if (!posEnvio.ok) {
        log({
          funcao: FUNCAO,
          evento: "update_pos_envio",
          status: "erro",
          atendimento_id: atendimentoId,
          mensagem_id: mensagemId,
          duracao_ms: t(),
          erro_msg: posEnvio.erro ?? "erro_desconhecido",
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
      const upd = atualizacaoAposErroEnvio(err, mediaMetadata);
      const motivo =
        (upd.media_metadata.erro_motivo ?? upd.media_metadata.envio_incerto_motivo) as string;
      await supabase
        .from("mensagens")
        .update(upd)
        .eq("id", mensagemId);

      log({
        funcao: FUNCAO,
        evento: upd.status_envio === "falha" ? "envio_falha" : "envio_incerto",
        status: upd.status_envio === "falha" ? "erro" : "ok",
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
