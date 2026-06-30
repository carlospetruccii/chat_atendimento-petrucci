// Edge Function: webhook-zapi-receive
// Endpoint público chamado pela Z-API para entregar eventos de WhatsApp.
//
// Princípios:
//   - Sempre responde 200 quando o payload é parseável (evita reentrega em loop).
//   - Idempotente via UNIQUE em mensagens.zapi_message_id.
//   - NÃO consulta bot_ativo: webhook só recebe; quem responde respeita kill switch.
//   - Mídias: persiste imediatamente apontando para a URL temporária da Z-API e,
//     em background, baixa e sobe ao Storage substituindo o media_url.
//
// Validação leve de origem: header Client-Token == ZAPI_CLIENT_TOKEN.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";

const FUNCAO = "webhook-zapi-receive";
const BUCKET = "mensagens-midia";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, client-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type TipoMensagem =
  | "texto"
  | "imagem"
  | "audio"
  | "documento"
  | "video"
  | "sticker"
  | "localizacao"
  | "contato";

type StatusWhatsapp = "enviado" | "entregue" | "lido" | "falha_whatsapp";

// Status entre status (que não envolvem inserir mensagem inbound).
const STATUS_TIPOS = new Set([
  "MessageStatusCallback",
  "DeliveryCallback",
  "ReadCallback",
]);

// Status string da Z-API → enum status_whatsapp_mensagem.
function mapStatusWhatsapp(s: string | undefined | null): StatusWhatsapp | null {
  if (!s) return null;
  const u = s.toUpperCase();
  if (u === "SENT") return "enviado";
  if (u === "RECEIVED" || u === "DELIVERED") return "entregue";
  if (u === "READ" || u === "PLAYED") return "lido";
  if (u === "FAILED" || u === "ERROR") return "falha_whatsapp";
  return null;
}

interface ParsedMensagem {
  tipo: TipoMensagem;
  content: string | null;
  media_url: string | null;
  media_metadata: Record<string, unknown> | null;
}

// Detecta o tipo de mensagem e extrai conteúdo/metadados do payload Z-API.
// A Z-API envia diferentes campos conforme o tipo (text.message, image.imageUrl, etc.).
function parseMensagem(p: Record<string, unknown>): ParsedMensagem | null {
  const get = <T = unknown>(k: string): T | undefined =>
    p[k] as T | undefined;

  const text = get<{ message?: string }>("text");
  if (text?.message != null) {
    return { tipo: "texto", content: String(text.message), media_url: null, media_metadata: null };
  }

  const image = get<{ imageUrl?: string; caption?: string; mimeType?: string }>("image");
  if (image?.imageUrl) {
    return {
      tipo: "imagem",
      content: image.caption ?? null,
      media_url: image.imageUrl,
      media_metadata: { mime_type: image.mimeType ?? null },
    };
  }

  const audio = get<{ audioUrl?: string; mimeType?: string; seconds?: number }>("audio");
  if (audio?.audioUrl) {
    return {
      tipo: "audio",
      content: null,
      media_url: audio.audioUrl,
      media_metadata: { mime_type: audio.mimeType ?? null, duracao_seg: audio.seconds ?? null },
    };
  }

  const video = get<{ videoUrl?: string; caption?: string; mimeType?: string }>("video");
  if (video?.videoUrl) {
    return {
      tipo: "video",
      content: video.caption ?? null,
      media_url: video.videoUrl,
      media_metadata: { mime_type: video.mimeType ?? null },
    };
  }

  const document = get<{ documentUrl?: string; mimeType?: string; fileName?: string; pageCount?: number }>("document");
  if (document?.documentUrl) {
    return {
      tipo: "documento",
      content: null,
      media_url: document.documentUrl,
      media_metadata: {
        mime_type: document.mimeType ?? null,
        file_name: document.fileName ?? null,
        paginas: document.pageCount ?? null,
      },
    };
  }

  const sticker = get<{ stickerUrl?: string; mimeType?: string }>("sticker");
  if (sticker?.stickerUrl) {
    return {
      tipo: "sticker",
      content: null,
      media_url: sticker.stickerUrl,
      media_metadata: { mime_type: sticker.mimeType ?? null },
    };
  }

  const location = get<{ latitude?: number; longitude?: number; address?: string }>("location");
  if (location && (location.latitude != null || location.longitude != null)) {
    return {
      tipo: "localizacao",
      content: location.address ?? null,
      media_url: null,
      media_metadata: { latitude: location.latitude ?? null, longitude: location.longitude ?? null },
    };
  }

  const contact = get<{ displayName?: string; vCard?: string }>("contact");
  if (contact?.displayName || contact?.vCard) {
    return {
      tipo: "contato",
      content: contact.displayName ?? null,
      media_url: null,
      media_metadata: { vcard: contact.vCard ?? null },
    };
  }

  // ===== Respostas interativas (Send List / Buttons) =====
  // A Z-API envia o resultado da seleção em payloads sem `text.message`,
  // usando estruturas como `listResponseMessage`, `buttonsResponseMessage`,
  // `interactiveResponseMessage` etc. Sem este parsing, a resposta do
  // cliente seria silenciosamente descartada e a triagem ficaria parada.

  const pickStr = (...vals: unknown[]): string | null => {
    for (const v of vals) {
      if (typeof v === "string" && v.trim() !== "") return v;
    }
    return null;
  };

  // 1) List reply
  const listKeys = Object.keys(p).filter((k) => /list/i.test(k) && /response|reply/i.test(k));
  for (const k of ["listResponseMessage", "listResponse", ...listKeys]) {
    const lr = p[k] as Record<string, unknown> | undefined;
    if (!lr || typeof lr !== "object") continue;
    const single = (lr as { singleSelectReply?: Record<string, unknown> }).singleSelectReply;
    const titulo = pickStr(
      (lr as { title?: unknown }).title,
      (lr as { selectedDisplayText?: unknown }).selectedDisplayText,
      (lr as { message?: unknown }).message,
      (lr as { description?: unknown }).description,
      single && (single as { selectedRowId?: unknown }).selectedRowId,
    );
    const rowId = pickStr(
      (lr as { selectedRowId?: unknown }).selectedRowId,
      single && (single as { selectedRowId?: unknown }).selectedRowId,
      (lr as { rowId?: unknown }).rowId,
    );
    if (titulo || rowId) {
      return {
        tipo: "texto",
        content: titulo ?? rowId ?? "",
        media_url: null,
        media_metadata: {
          kind: "list_reply",
          selected_row_id: rowId,
          source: "whatsapp_interactive",
        },
      };
    }
  }

  // 2) Button reply
  for (const k of ["buttonsResponseMessage", "buttonResponseMessage", "interactiveResponseMessage", "templateButtonReplyMessage"]) {
    const br = p[k] as Record<string, unknown> | undefined;
    if (!br || typeof br !== "object") continue;
    const titulo = pickStr(
      (br as { selectedDisplayText?: unknown }).selectedDisplayText,
      (br as { selectedButtonText?: unknown }).selectedButtonText,
      (br as { message?: unknown }).message,
      (br as { title?: unknown }).title,
    );
    const buttonId = pickStr(
      (br as { selectedButtonId?: unknown }).selectedButtonId,
      (br as { buttonId?: unknown }).buttonId,
      (br as { selectedId?: unknown }).selectedId,
    );
    if (titulo || buttonId) {
      return {
        tipo: "texto",
        content: titulo ?? buttonId ?? "",
        media_url: null,
        media_metadata: {
          kind: "button_reply",
          selected_button_id: buttonId,
          source: "whatsapp_interactive",
        },
      };
    }
  }

  return null;
}

const STATUS_INSTAVEL_ATENDIMENTO = ["em_triagem", "reservado", "pendente", "em_atendimento"];

// Tipos cuja mídia precisa ser persistida no Storage.
const TIPOS_COM_DOWNLOAD = new Set<TipoMensagem>(["imagem", "audio", "video", "documento", "sticker"]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Normaliza número para E.164 com '+' (Z-API manda sem '+').
function normalizarNumero(n: string | null | undefined): string | null {
  if (!n) return null;
  const digits = String(n).replace(/\D/g, "");
  if (!digits) return null;
  return `+${digits}`;
}

// Mascarar número para logs: mantém DDI+DDD e últimos 2 dígitos.
function mascararNumero(n: string | null | undefined): string | null {
  if (!n) return null;
  const d = String(n).replace(/\D/g, "");
  if (d.length < 6) return "***";
  return `${d.slice(0, 4)}***${d.slice(-2)}`;
}

// Detecta se payload.phone é LID (não E.164). Regra composta:
//  - sufixo @lid → LID
//  - sufixo @g.us → grupo (não LID, tratado pelo guard de grupo)
//  - se chatLid existe e bate (em dígitos) com phone → LID
//  - caso contrário, assume E.164.
function ehLid(
  rawPhone: string | null | undefined,
  chatLid: string | null | undefined,
): boolean {
  if (!rawPhone) return false;
  const s = String(rawPhone);
  if (s.includes("@lid")) return true;
  if (s.includes("@g.us")) return false;
  if (chatLid) {
    const phoneDigits = s.split("@")[0].replace(/\D/g, "");
    const lidDigits = String(chatLid).split("@")[0].replace(/\D/g, "");
    if (phoneDigits && lidDigits && phoneDigits === lidDigits) return true;
  }
  return false;
}

function extrairLid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).split("@")[0];
  const digits = s.replace(/\D/g, "");
  return digits || null;
}

function ehGrupo(payload: Record<string, unknown>): boolean {
  if ((payload as { isGroup?: unknown }).isGroup === true) return true;
  const phone = (payload as { phone?: string }).phone;
  return typeof phone === "string" && phone.includes("@g.us");
}

// Mascara LID para logs (RNF-S10): mantém 4 primeiros e 2 últimos.
function mascararLid(lid: string | null | undefined): string | null {
  if (!lid) return null;
  const s = String(lid);
  if (s.length < 8) return "***";
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}

interface ClienteResolvido {
  id: string;
  nome: string | null;
  via: "e164" | "lid";
}

type ResolverErro =
  | { erro: "sem_telefone" }
  | { erro: "lid_desconhecido"; via_tentada: "e164" | "lid" }
  | { erro: "criar_erro"; detalhe?: string };

async function resolverClienteIdent(
  payload: Record<string, unknown>,
  supabase: ReturnType<typeof getSupabaseAdmin>,
  opts: { permitirCriar: boolean; senderName: string | null },
): Promise<ClienteResolvido | ResolverErro> {
  const rawPhone = (payload.phone as string | undefined) ?? null;
  const chatLidRaw = (payload as { chatLid?: string }).chatLid ?? null;
  const chatLidNorm = extrairLid(chatLidRaw);

  if (!ehLid(rawPhone, chatLidRaw)) {
    // Caminho E.164.
    const numero = normalizarNumero(rawPhone);
    if (!numero) return { erro: "sem_telefone" };

    const { data: c } = await supabase
      .from("clients")
      .select("id, nome, chat_lid")
      .eq("numero_whatsapp", numero)
      .maybeSingle();

    if (c) {
      if (chatLidNorm && !c.chat_lid) {
        const { error } = await supabase
          .from("clients")
          .update({ chat_lid: chatLidNorm })
          .eq("id", c.id)
          .is("chat_lid", null);
        if (!error) {
          log({
            funcao: FUNCAO,
            evento: "chat_lid_populado",
            status: "ok",
            client_id: c.id,
            extra: { chat_lid_mask: mascararLid(chatLidNorm) },
          });
        }
      }
      if (!c.nome && opts.senderName) {
        await supabase.from("clients").update({ nome: opts.senderName }).eq("id", c.id);
      }
      return { id: c.id, nome: c.nome, via: "e164" };
    }

    if (!opts.permitirCriar) return { erro: "lid_desconhecido", via_tentada: "e164" };

    const { data: novo, error } = await supabase
      .from("clients")
      .insert({ numero_whatsapp: numero, nome: opts.senderName, chat_lid: chatLidNorm })
      .select("id, nome")
      .single();
    if (error || !novo) return { erro: "criar_erro", detalhe: error?.message };
    return { id: novo.id, nome: novo.nome, via: "e164" };
  }

  // Caminho LID.
  const lid = extrairLid(rawPhone) ?? chatLidNorm;
  if (!lid) return { erro: "sem_telefone" };

  const { data: c } = await supabase
    .from("clients")
    .select("id, nome")
    .eq("chat_lid", lid)
    .maybeSingle();
  if (c) return { id: c.id, nome: c.nome, via: "lid" };

  return { erro: "lid_desconhecido", via_tentada: "lid" };
}

// Verifica se o atendimento já recebeu alguma mensagem outbound enviada
// FORA do sistema (sender_type='externo'). Sinaliza que existe uma atendente
// humana cuidando do cliente diretamente pelo WhatsApp e que o bot não deve
// reabrir triagem nem encerrar por virada de dia.
async function temAtividadeExterna(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  atendimentoId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("mensagens")
    .select("id")
    .eq("atendimento_id", atendimentoId)
    .eq("direction", "outbound")
    .eq("sender_type", "externo")
    .limit(1)
    .maybeSingle();
  return !!data;
}

// Procura o último atendimento encerrado nas últimas 24h desse cliente que
// merece reabertura automática: ou foi encerrado por inatividade, ou tem
// conversa externa registrada (atendente respondeu pelo WhatsApp pessoal).
// Retorna { id, current_department_id, assigned_to, close_reason } ou null.
async function buscarEncerradoReabrivel(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  clientId: string,
): Promise<
  {
    id: string;
    current_department_id: string | null;
    assigned_to: string | null;
    closed_at: string | null;
    close_reason: string | null;
  } | null
> {
  const cutoff24hIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: candidatos } = await supabase
    .from("atendimentos")
    .select("id, current_department_id, assigned_to, closed_at, close_reason")
    .eq("client_id", clientId)
    .eq("status", "encerrado")
    .gte("closed_at", cutoff24hIso)
    .order("closed_at", { ascending: false })
    .limit(5);
  if (!candidatos || candidatos.length === 0) return null;

  for (const c of candidatos as Array<{
    id: string;
    current_department_id: string | null;
    assigned_to: string | null;
    closed_at: string | null;
    close_reason: string | null;
  }>) {
    if (c.close_reason === "automatico_inatividade") return c;
    if (await temAtividadeExterna(supabase, c.id)) return c;
  }
  return null;
}

// Reabre o atendimento encerrado escolhido. Retorna o id se sucesso.
async function reabrirAtendimentoEncerrado(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  enc: {
    id: string;
    current_department_id: string | null;
    assigned_to: string | null;
    closed_at: string | null;
    close_reason: string | null;
  },
  clientId: string,
  origem: string,
  zapiMessageId: string | null,
): Promise<{ id: string; current_department_id: string | null } | null> {
  const novoStatus = enc.assigned_to ? "em_atendimento" : "pendente";
  const closedAtAnterior = enc.closed_at;
  const closeReasonAnterior = enc.close_reason;

  const { error: errReabrir } = await supabase
    .from("atendimentos")
    .update({
      status: novoStatus,
      closed_at: null,
      closed_by_user_id: null,
      close_reason: null,
    })
    .eq("id", enc.id)
    .eq("status", "encerrado");

  if (errReabrir) {
    log({
      funcao: FUNCAO,
      evento: "reabertura_automatica_erro",
      status: "erro",
      atendimento_id: enc.id,
      client_id: clientId,
      erro_msg: errReabrir.message,
    });
    return null;
  }

  await supabase.from("timeline_events").insert({
    atendimento_id: enc.id,
    tipo_evento: "reabertura_automatica",
    actor_user_id: null,
    target_user_id: enc.assigned_to ?? null,
    payload: {
      motivo: origem,
      closed_at_anterior: closedAtAnterior,
      close_reason_anterior: closeReasonAnterior,
      novo_status: novoStatus,
      zapi_message_id: zapiMessageId,
    },
  });

  log({
    funcao: FUNCAO,
    evento: "atendimento_reaberto_automatico",
    status: "ok",
    atendimento_id: enc.id,
    client_id: clientId,
    extra: {
      novo_status: novoStatus,
      close_reason_anterior: closeReasonAnterior,
      origem,
    },
  });

  return { id: enc.id, current_department_id: enc.current_department_id };
}

function deduzirExtensao(mime: string | null | undefined, fallback: string): string {
  if (!mime) return fallback;
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "video/mp4": "mp4",
    "application/pdf": "pdf",
  };
  return map[mime.toLowerCase()] ?? fallback;
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

  // 1) Validação leve de origem.
  const expectedClientToken = Deno.env.get("ZAPI_CLIENT_TOKEN");
  const headerClientToken = req.headers.get("Client-Token") ?? req.headers.get("client-token");
  if (expectedClientToken && headerClientToken && headerClientToken !== expectedClientToken) {
    log({ funcao: FUNCAO, evento: "client_token_invalido", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }
  if (expectedClientToken && !headerClientToken) {
    log({ funcao: FUNCAO, evento: "sem_client_token", status: "ok" });
  }

  // 2) Parse do payload.
  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    log({ funcao: FUNCAO, evento: "payload_invalido", status: "erro", duracao_ms: cron() });
    // 200 mesmo assim para não fazer Z-API reenviar payload quebrado.
    return jsonResponse({ ok: true, ignorado: "payload_invalido" });
  }

  const tipoEvento = (payload.type as string | undefined) ?? null;
  const fromMe = payload.fromMe === true;
  const zapiMessageId =
    (payload.messageId as string | undefined) ??
      (payload.id as string | undefined) ??
      null;

  // referenceMessageId: presente quando a mensagem é uma resposta (citação) a outra
  // do WhatsApp. Resolve para nossa mensagens.id correspondente, se existir.
  const referenceMessageId =
    (payload.referenceMessageId as string | undefined) ??
      ((payload as { messageContextInfo?: { stanzaId?: string } }).messageContextInfo?.stanzaId) ??
      null;
  let replyToMessageId: string | null = null;
  if (referenceMessageId) {
    const { data: refRow } = await supabase
      .from("mensagens")
      .select("id")
      .eq("zapi_message_id", referenceMessageId)
      .maybeSingle();
    if (refRow?.id) replyToMessageId = refRow.id as string;
  }

  log({
    funcao: FUNCAO,
    evento: "webhook_recebido",
    status: "ok",
    extra: { tipo_evento: tipoEvento, from_me: fromMe, has_message_id: !!zapiMessageId },
  });

  // Instrumentação temporária (RNF-S10 — proibido logar conteúdo da mensagem):
  // logamos apenas a ESTRUTURA do payload e os campos de detecção de origem,
  // para diagnosticar mensagens enviadas pelo nosso número fora do sistema que
  // estão chegando como inbound. Não logar text/body/caption/conversation.
  try {
    const key = (payload as { key?: Record<string, unknown> }).key ?? null;
    log({
      funcao: FUNCAO,
      evento: "webhook_payload_estrutura",
      status: "ok",
      extra: {
        tipo_evento: tipoEvento,
        zapi_message_id: zapiMessageId,
        timestamp_payload: (payload as { momment?: unknown; timestamp?: unknown }).momment
          ?? (payload as { timestamp?: unknown }).timestamp ?? null,
        telefone_mask: mascararNumero((payload as { phone?: string }).phone),
        // Lista completa de chaves do payload (estrutura, sem valores).
        keys_top: Object.keys(payload),
        keys_key: key && typeof key === "object" ? Object.keys(key) : null,
        // Campos relevantes para detecção de origem.
        from_me_top: (payload as { fromMe?: unknown }).fromMe ?? null,
        from_me_top_tipo: typeof (payload as { fromMe?: unknown }).fromMe,
        from_me_key: key && typeof key === "object"
          ? (key as { fromMe?: unknown }).fromMe ?? null
          : null,
        is_group: (payload as { isGroup?: unknown }).isGroup ?? null,
        participant: (payload as { participant?: unknown }).participant ?? null,
        participant_phone: (payload as { participantPhone?: unknown }).participantPhone ?? null,
        sender_jid: (payload as { senderJid?: unknown }).senderJid ?? null,
        sender_phone_mask: mascararNumero(
          (payload as { senderPhone?: string }).senderPhone,
        ),
        sender_name: (payload as { senderName?: unknown }).senderName ?? null,
        instance_id: (payload as { instanceId?: unknown }).instanceId ?? null,
        message_type: (payload as { messageType?: unknown }).messageType ?? null,
        connected_phone_mask: mascararNumero(
          (payload as { connectedPhone?: string }).connectedPhone,
        ),
        from_api: (payload as { fromApi?: unknown }).fromApi ?? null,
        chat_lid: (payload as { chatLid?: unknown }).chatLid ?? null,
        chat_name: typeof (payload as { chatName?: unknown }).chatName === "string"
          ? ((payload as { chatName: string }).chatName).slice(0, 30)
          : null,
        participant_lid: (payload as { participantLid?: unknown }).participantLid ?? null,
        forwarded: (payload as { forwarded?: unknown }).forwarded ?? null,
        status_payload: (payload as { status?: unknown }).status ?? null,
      },
    });
  } catch (e) {
    log({
      funcao: FUNCAO,
      evento: "webhook_payload_estrutura_erro",
      status: "erro",
      erro_msg: e instanceof Error ? e.message : String(e),
    });
  }

  // Guard: mensagens de grupo são descartadas explicitamente. payload.phone
  // vem como "...@g.us" e violaria o CHECK E.164 ao tentar criar cliente.
  if (ehGrupo(payload)) {
    log({
      funcao: FUNCAO,
      evento: "evento_ignorado",
      status: "ok",
      extra: { motivo: "mensagem_grupo", tipo_evento: tipoEvento },
    });
    return jsonResponse({ ok: true });
  }

  try {
    // 3) Roteamento por tipo de evento.

    // 3a) Status de mensagem outbound (delivered/read/...).
    if (tipoEvento && STATUS_TIPOS.has(tipoEvento)) {
      const statusStr =
        (payload.status as string | undefined) ??
          ((payload as { messageStatus?: { status?: string } }).messageStatus?.status);
      const novoStatus = mapStatusWhatsapp(statusStr ?? null);
      // Z-API às vezes manda lista de IDs em "ids".
      const ids: string[] = Array.isArray((payload as { ids?: unknown }).ids)
        ? ((payload as { ids: unknown[] }).ids).filter((x): x is string => typeof x === "string")
        : zapiMessageId
          ? [zapiMessageId]
          : [];

      if (!novoStatus || ids.length === 0) {
        log({
          funcao: FUNCAO,
          evento: "status_ignorado",
          status: "ok",
          extra: { tipo_evento: tipoEvento, status_str: statusStr ?? null },
        });
        return jsonResponse({ ok: true });
      }

      let atualizadas = 0;
      let orfaos = 0;
      for (const id of ids) {
        const { data, error } = await supabase
          .from("mensagens")
          .update({ status_whatsapp: novoStatus })
          .eq("zapi_message_id", id)
          .select("id");
        if (error) {
          log({
            funcao: FUNCAO,
            evento: "status_update_erro",
            status: "erro",
            erro_msg: error.message,
            extra: { zapi_message_id: id },
          });
          continue;
        }
        if (!data || data.length === 0) {
          orfaos++;
          log({
            funcao: FUNCAO,
            evento: "status_orfao",
            status: "ok",
            extra: { zapi_message_id: id, status_novo: novoStatus },
          });
        } else {
          atualizadas++;
          log({
            funcao: FUNCAO,
            evento: "status_atualizado",
            status: "ok",
            mensagem_id: data[0].id,
            extra: { zapi_message_id: id, status_novo: novoStatus },
          });
        }
      }
      return jsonResponse({ ok: true, atualizadas, orfaos });
    }

    // 3b) Mensagem outbound originada FORA do sistema (alguém respondeu pelo
    // celular usando o número da empresa). RN-20 / ADR-022 — registrar como
    // sender_type='externo' para dar visibilidade na Inbox.
    // Mensagens que NÓS mesmos enviamos via send-whatsapp-message também voltam
    // como fromMe=true; o UNIQUE em zapi_message_id garante idempotência —
    // tratamento de 23505 é idêntico ao caminho inbound (silenciar como duplicada).
    if (fromMe) {
      const parsedExt = parseMensagem(payload);
      if (!parsedExt) {
        log({
          funcao: FUNCAO,
          evento: "evento_ignorado",
          status: "ok",
          extra: { motivo: "from_me_tipo_nao_suportado", tipo_evento: tipoEvento },
        });
        return jsonResponse({ ok: true });
      }
      if (!zapiMessageId) {
        log({
          funcao: FUNCAO,
          evento: "evento_ignorado",
          status: "ok",
          extra: { motivo: "from_me_sem_message_id" },
        });
        return jsonResponse({ ok: true });
      }

      // Idempotência prévia (cobre tanto o eco do nosso send-whatsapp-message
      // quanto reentrega de webhook).
      const { data: jaExiste } = await supabase
        .from("mensagens")
        .select("id")
        .eq("zapi_message_id", zapiMessageId)
        .maybeSingle();
      if (jaExiste) {
        log({
          funcao: FUNCAO,
          evento: "mensagem_duplicada",
          status: "ok",
          mensagem_id: jaExiste.id,
          extra: { zapi_message_id: zapiMessageId, origem: "from_me" },
        });
        return jsonResponse({ ok: true, duplicada: true });
      }

      // Localiza cliente via E.164 OU LID (ADR-045).
      const resolved = await resolverClienteIdent(payload, supabase, {
        permitirCriar: false,
        senderName: null,
      });
      if ("erro" in resolved) {
        if (resolved.erro === "sem_telefone") {
          log({
            funcao: FUNCAO,
            evento: "evento_ignorado",
            status: "ok",
            extra: { motivo: "from_me_sem_telefone" },
          });
        } else if (resolved.erro === "lid_desconhecido") {
          log({
            funcao: FUNCAO,
            evento: "evento_ignorado",
            status: "ok",
            extra: {
              motivo: "cliente_lid_desconhecido",
              via_tentada: resolved.via_tentada,
              telefone_mask: mascararNumero(payload.phone as string | undefined),
              chat_lid_mask: mascararLid(
                (payload as { chatLid?: string }).chatLid ?? null,
              ),
            },
          });
        } else {
          log({
            funcao: FUNCAO,
            evento: "evento_ignorado",
            status: "ok",
            extra: { motivo: "from_me_resolver_erro", detalhe: resolved.detalhe ?? null },
          });
        }
        return jsonResponse({ ok: true });
      }
      const clienteExt = { id: resolved.id };

      // Exige atendimento ativo desse cliente — não criamos triagem a partir
      // de uma mensagem outbound externa.
      let atendExt = (await supabase
        .from("atendimentos")
        .select("id, current_department_id")
        .eq("client_id", clienteExt.id)
        .in("status", STATUS_INSTAVEL_ATENDIMENTO)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()).data as { id: string; current_department_id: string | null } | null;

      // Opção A: se não há atendimento ativo, tenta reabrir o último encerrado
      // que merece reabertura (inatividade automática OU já tinha conversa
      // externa em andamento) nas últimas 24h.
      if (!atendExt) {
        const enc = await buscarEncerradoReabrivel(supabase, clienteExt.id);
        if (enc) {
          const reaberto = await reabrirAtendimentoEncerrado(
            supabase,
            enc,
            clienteExt.id,
            "mensagem_externa_pos_encerramento",
            zapiMessageId,
          );
          if (!reaberto) {
            return jsonResponse({ ok: true });
          }
          atendExt = reaberto;
        }
      }

      if (!atendExt) {
        log({
          funcao: FUNCAO,
          evento: "evento_ignorado",
          status: "ok",
          client_id: clienteExt.id,
          extra: { motivo: "externo_sem_atendimento_ativo" },
        });
        return jsonResponse({ ok: true });
      }

      const { data: msgExt, error: errExt } = await supabase
        .from("mensagens")
        .insert({
          atendimento_id: atendExt.id,
          client_id: clienteExt.id,
          department_id: atendExt.current_department_id,
          direction: "outbound",
          sender_type: "externo",
          sent_by_user_id: null,
          tipo: parsedExt.tipo,
          content: parsedExt.content,
          media_url: parsedExt.media_url,
          media_metadata: parsedExt.media_metadata,
          zapi_message_id: zapiMessageId,
          status_envio: "enviado",
          status_whatsapp: "enviado",
          reply_to_message_id: replyToMessageId,
        })
        .select("id")
        .maybeSingle();

      if (errExt) {
        const isUnique = (errExt.code === "23505") ||
          /duplicate key|uniq_mensagens_zapi_message_id/i.test(errExt.message);
        if (isUnique) {
          log({
            funcao: FUNCAO,
            evento: "mensagem_duplicada",
            status: "ok",
            extra: { zapi_message_id: zapiMessageId, origem: "from_me", via: "conflict" },
          });
          return jsonResponse({ ok: true, duplicada: true });
        }
        log({
          funcao: FUNCAO,
          evento: "insert_mensagem_erro",
          status: "erro",
          erro_msg: errExt.message,
          atendimento_id: atendExt.id,
          extra: { origem: "from_me" },
        });
        return jsonResponse({ ok: true });
      }

      const mensagemExtId = msgExt!.id as string;
      log({
        funcao: FUNCAO,
        evento: "mensagem_externa_persistida",
        status: "ok",
        atendimento_id: atendExt.id,
        mensagem_id: mensagemExtId,
        client_id: clienteExt.id,
        duracao_ms: cron(),
        extra: { tipo: parsedExt.tipo, zapi_message_id: zapiMessageId },
      });

      // Mídia: mesmo fluxo do inbound.
      if (TIPOS_COM_DOWNLOAD.has(parsedExt.tipo) && parsedExt.media_url) {
        const tarefa = baixarESalvarMidia({
          mensagemId: mensagemExtId,
          atendimentoId: atendExt.id,
          clientId: clienteExt.id,
          urlOriginal: parsedExt.media_url,
          tipo: parsedExt.tipo,
          metaInicial: parsedExt.media_metadata ?? {},
        });
        const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
          .EdgeRuntime;
        if (edge?.waitUntil) edge.waitUntil(tarefa);
        else tarefa.catch(() => {});
      }

      return jsonResponse({ ok: true, mensagem_id: mensagemExtId, externo: true });
    }

    // 3c) Mensagem inbound do cliente.
    const parsed = parseMensagem(payload);
    if (!parsed) {
      log({
        funcao: FUNCAO,
        evento: "evento_ignorado",
        status: "ok",
        extra: {
          motivo: "tipo_nao_suportado",
          tipo_evento: tipoEvento,
          keys_top: Object.keys(payload),
          message_type: (payload as { messageType?: unknown }).messageType ?? null,
        },
      });
      return jsonResponse({ ok: true });
    }

    if (!zapiMessageId) {
      log({ funcao: FUNCAO, evento: "evento_ignorado", status: "ok", extra: { motivo: "sem_message_id" } });
      return jsonResponse({ ok: true });
    }

    // 3c.1) Idempotência prévia: já existe mensagem com esse zapi_message_id?
    const { data: existente } = await supabase
      .from("mensagens")
      .select("id")
      .eq("zapi_message_id", zapiMessageId)
      .maybeSingle();
    if (existente) {
      log({
        funcao: FUNCAO,
        evento: "mensagem_duplicada",
        status: "ok",
        mensagem_id: existente.id,
        extra: { zapi_message_id: zapiMessageId },
      });
      return jsonResponse({ ok: true, duplicada: true });
    }

    // 3c.2) Resolve / cria cliente (E.164 ou LID — ADR-045).
    const senderName =
      (payload.senderName as string | undefined) ??
        (payload.chatName as string | undefined) ??
        null;

    const resolvedIn = await resolverClienteIdent(payload, supabase, {
      permitirCriar: true,
      senderName,
    });
    if ("erro" in resolvedIn) {
      if (resolvedIn.erro === "sem_telefone") {
        log({ funcao: FUNCAO, evento: "evento_ignorado", status: "ok", extra: { motivo: "sem_telefone" } });
      } else if (resolvedIn.erro === "criar_erro") {
        log({
          funcao: FUNCAO,
          evento: "criar_cliente_erro",
          status: "erro",
          erro_msg: resolvedIn.detalhe,
          extra: { telefone_mask: mascararNumero(payload.phone as string | undefined) },
        });
      } else {
        // Inbound só com LID e sem cliente prévio: não dá para criar (CHECK E.164).
        log({
          funcao: FUNCAO,
          evento: "evento_ignorado",
          status: "ok",
          extra: {
            motivo: "inbound_lid_sem_cliente",
            via_tentada: resolvedIn.via_tentada,
            chat_lid_mask: mascararLid((payload as { chatLid?: string }).chatLid ?? null),
          },
        });
      }
      return jsonResponse({ ok: true });
    }
    const cliente = { id: resolvedIn.id, nome: resolvedIn.nome };

    // 3c.3) Resolve atendimento ativo OU cria novo em em_triagem.
    let { data: atend } = await supabase
      .from("atendimentos")
      .select("id, status, current_department_id, triagem_started_at, created_at")
      .eq("client_id", cliente.id)
      .in("status", STATUS_INSTAVEL_ATENDIMENTO)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle() as {
        data: {
          id: string;
          status: string;
          current_department_id: string | null;
          triagem_started_at: string | null;
          created_at: string;
        } | null;
      };

    // 3c.3.b) Se o atendimento ativo está em em_triagem e a data local
    // (America/Sao_Paulo) do início da triagem é anterior à data local de
    // agora, encerra-o e força a criação de um novo atendimento (nova triagem).
    if (atend && atend.status === "em_triagem") {
      const { data: cfgRow } = await supabase
        .from("system_config")
        .select("valor")
        .eq("chave", "triagem_reinicia_ao_virar_dia")
        .maybeSingle();
      const reiniciarVirarDia = (cfgRow?.valor ?? "true") === "true";

      if (reiniciarVirarDia) {
        const inicioIso = atend.triagem_started_at ?? atend.created_at;
        const TZ = "America/Sao_Paulo";
        const fmt = new Intl.DateTimeFormat("en-CA", {
          timeZone: TZ,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
        const dataInicio = fmt.format(new Date(inicioIso)); // YYYY-MM-DD
        const dataAgora = fmt.format(new Date());

        if (dataInicio < dataAgora) {
          // Antes de encerrar por virada de dia, verificar se há conversa
          // externa em andamento. Se sim, NÃO encerrar — apenas tirar da
          // triagem e promover para pendente, evitando que o bot recomece e
          // que o cliente perca o contexto da atendente humana.
          const temExterno = await temAtividadeExterna(supabase, atend.id);

          if (temExterno) {
            const { data: cfgDeptDefault } = await supabase
              .from("system_config")
              .select("valor")
              .eq("chave", "triagem_departamento_default")
              .maybeSingle();
            const deptDefault = (cfgDeptDefault?.valor ?? null) as string | null;
            const deptResolvido = atend.current_department_id ?? deptDefault;

            if (!deptResolvido) {
              log({
                funcao: FUNCAO,
                evento: "promocao_externa_sem_dept",
                status: "erro",
                atendimento_id: atend.id,
                client_id: cliente.id,
              });
            } else {
              const agoraIso = new Date().toISOString();
              const { error: errProm } = await supabase
                .from("atendimentos")
                .update({
                  status: "pendente",
                  current_department_id: deptResolvido,
                  triagem_estagio: "concluida",
                  triagem_finished_at: agoraIso,
                })
                .eq("id", atend.id)
                .eq("status", "em_triagem");

              if (!errProm) {
                await supabase.from("mensagens")
                  .update({ department_id: deptResolvido })
                  .eq("atendimento_id", atend.id)
                  .is("department_id", null);

                await supabase.from("timeline_events").insert({
                  atendimento_id: atend.id,
                  tipo_evento: "escalado",
                  actor_user_id: null,
                  to_department_id: deptResolvido,
                  payload: {
                    motivo: "atendimento_externo_detectado",
                    data_inicio_local: dataInicio,
                    data_agora_local: dataAgora,
                  },
                });

                log({
                  funcao: FUNCAO,
                  evento: "triagem_promovida_por_externo",
                  status: "ok",
                  atendimento_id: atend.id,
                  client_id: cliente.id,
                  extra: { dept: deptResolvido },
                });

                // Atualiza ref local para o restante do fluxo seguir nesse mesmo
                // atendimento, sem criar nova triagem.
                atend = {
                  ...atend,
                  status: "pendente",
                  current_department_id: deptResolvido,
                };
              } else {
                log({
                  funcao: FUNCAO,
                  evento: "triagem_promover_externo_erro",
                  status: "erro",
                  atendimento_id: atend.id,
                  client_id: cliente.id,
                  erro_msg: errProm.message,
                });
              }
            }
          } else {
            const { error: errEnc } = await supabase
              .from("atendimentos")
              .update({
                status: "encerrado",
                closed_at: new Date().toISOString(),
                close_reason: "triagem_expirada_dia",
                triagem_estagio: "concluida",
              })
              .eq("id", atend.id)
              .eq("status", "em_triagem");

            if (!errEnc) {
              await supabase.from("timeline_events").insert({
                atendimento_id: atend.id,
                tipo_evento: "encerrado",
                actor_user_id: null,
                payload: {
                  motivo: "triagem_expirada_dia",
                  data_inicio_local: dataInicio,
                  data_agora_local: dataAgora,
                },
              });
              log({
                funcao: FUNCAO,
                evento: "triagem_expirada_dia_encerrada",
                status: "ok",
                atendimento_id: atend.id,
                client_id: cliente.id,
                extra: { data_inicio_local: dataInicio, data_agora_local: dataAgora },
              });
              atend = null; // força criação de novo atendimento abaixo
            } else {
              log({
                funcao: FUNCAO,
                evento: "triagem_expirada_dia_encerrar_erro",
                status: "erro",
                atendimento_id: atend.id,
                client_id: cliente.id,
                erro_msg: errEnc.message,
              });
            }
          }
        }
      }
    }

    // 3c.3.c) Antes de criar uma triagem nova, tentar reabrir o último
    // atendimento encerrado nas últimas 24h se ele tiver conversa externa
    // ou se foi encerrado por inatividade. Evita que um cliente sendo
    // atendido pelo WhatsApp pessoal volte para a triagem do bot.
    if (!atend) {
      const enc = await buscarEncerradoReabrivel(supabase, cliente.id);
      if (enc) {
        const reaberto = await reabrirAtendimentoEncerrado(
          supabase,
          enc,
          cliente.id,
          "mensagem_inbound_pos_encerramento",
          zapiMessageId,
        );
        if (reaberto) {
          atend = {
            id: reaberto.id,
            status: enc.assigned_to ? "em_atendimento" : "pendente",
            current_department_id: reaberto.current_department_id,
            triagem_started_at: null,
            created_at: new Date().toISOString(),
          };
        }
      }
    }

    if (!atend) {
      const agora = new Date().toISOString();
      const { data: novoAtend, error: errAt } = await supabase
        .from("atendimentos")
        .insert({
          client_id: cliente.id,
          status: "em_triagem",
          current_department_id: null,
          assigned_to: null,
          triagem_started_at: agora,
        })
        .select("id, status, current_department_id")
        .single();
      if (errAt || !novoAtend) {
        log({
          funcao: FUNCAO,
          evento: "criar_atendimento_erro",
          status: "erro",
          erro_msg: errAt?.message,
          client_id: cliente.id,
        });
        return jsonResponse({ ok: true });
      }
      atend = novoAtend;
      log({
        funcao: FUNCAO,
        evento: "atendimento_criado",
        status: "ok",
        atendimento_id: atend.id,
        client_id: cliente.id,
      });
    }

    // 3c.4) Insere mensagem inbound (idempotência final via UNIQUE).
    const { data: msgInserida, error: errIns } = await supabase
      .from("mensagens")
      .insert({
        atendimento_id: atend.id,
        client_id: cliente.id,
        department_id: atend.current_department_id,
        direction: "inbound",
        sender_type: "cliente",
        sent_by_user_id: null,
        tipo: parsed.tipo,
        content: parsed.content,
        media_url: parsed.media_url,
        media_metadata: parsed.media_metadata,
        zapi_message_id: zapiMessageId,
        status_envio: "enviado",
        status_whatsapp: null,
        reply_to_message_id: replyToMessageId,
      })
      .select("id")
      .maybeSingle();

    if (errIns) {
      // Conflito UNIQUE = corrida; trata como duplicada.
      const isUnique = (errIns.code === "23505") ||
        /duplicate key|uniq_mensagens_zapi_message_id/i.test(errIns.message);
      if (isUnique) {
        log({
          funcao: FUNCAO,
          evento: "mensagem_duplicada",
          status: "ok",
          extra: { zapi_message_id: zapiMessageId, via: "conflict" },
        });
        return jsonResponse({ ok: true, duplicada: true });
      }
      log({
        funcao: FUNCAO,
        evento: "insert_mensagem_erro",
        status: "erro",
        erro_msg: errIns.message,
        atendimento_id: atend.id,
      });
      return jsonResponse({ ok: true });
    }

    const mensagemId = msgInserida!.id as string;
    log({
      funcao: FUNCAO,
      evento: "mensagem_persistida",
      status: "ok",
      atendimento_id: atend.id,
      mensagem_id: mensagemId,
      client_id: cliente.id,
      duracao_ms: cron(),
      extra: { tipo: parsed.tipo, zapi_message_id: zapiMessageId },
    });

    // 3c.5) Background: download da mídia para o Storage.
    if (TIPOS_COM_DOWNLOAD.has(parsed.tipo) && parsed.media_url) {
      const tarefa = baixarESalvarMidia({
        mensagemId,
        atendimentoId: atend.id,
        clientId: cliente.id,
        urlOriginal: parsed.media_url,
        tipo: parsed.tipo,
        metaInicial: parsed.media_metadata ?? {},
      });
      const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
        .EdgeRuntime;
      if (edge?.waitUntil) edge.waitUntil(tarefa);
      else tarefa.catch(() => {});
    }

    return jsonResponse({ ok: true, mensagem_id: mensagemId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ funcao: FUNCAO, evento: "erro_inesperado", status: "erro", erro_msg: msg.slice(0, 200) });
    // 200 mesmo assim — Z-API não deve reenviar.
    return jsonResponse({ ok: true, erro_interno: true });
  }
});

// --- Helpers ---

interface DownloadParams {
  mensagemId: string;
  atendimentoId: string;
  clientId: string;
  urlOriginal: string;
  tipo: TipoMensagem;
  metaInicial: Record<string, unknown>;
}

async function baixarESalvarMidia(p: DownloadParams): Promise<void> {
  const supabase = getSupabaseAdmin();
  const t = iniciarCronometro();
  log({
    funcao: FUNCAO,
    evento: "download_iniciado",
    status: "ok",
    mensagem_id: p.mensagemId,
    atendimento_id: p.atendimentoId,
    extra: { tipo: p.tipo },
  });
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 25000);
    const resp = await fetch(p.urlOriginal, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ao baixar mídia`);
    }
    const contentType = resp.headers.get("content-type") ?? (p.metaInicial.mime_type as string | null) ?? "application/octet-stream";
    const buf = new Uint8Array(await resp.arrayBuffer());

    const fallbackExtPorTipo: Record<TipoMensagem, string> = {
      imagem: "bin",
      audio: "ogg",
      video: "mp4",
      documento: "bin",
      texto: "txt",
      sticker: "webp",
      localizacao: "txt",
      contato: "vcf",
    };
    const ext = deduzirExtensao(contentType, fallbackExtPorTipo[p.tipo]);
    const path = `${p.atendimentoId}/${p.mensagemId}.${ext}`;

    const { error: errUp } = await supabase.storage
      .from(BUCKET)
      .upload(path, buf, { contentType, upsert: true });
    if (errUp) throw new Error(`storage_upload: ${errUp.message}`);

    const novaMeta = {
      ...p.metaInicial,
      mime_type: contentType,
      tamanho_bytes: buf.byteLength,
      bucket: BUCKET,
      storage_path: path,
      url_original_zapi: p.urlOriginal,
    };

    const { error: errUpd } = await supabase
      .from("mensagens")
      .update({ media_url: path, media_metadata: novaMeta })
      .eq("id", p.mensagemId);
    if (errUpd) throw new Error(`update_mensagem: ${errUpd.message}`);

    log({
      funcao: FUNCAO,
      evento: "download_sucesso",
      status: "ok",
      mensagem_id: p.mensagemId,
      atendimento_id: p.atendimentoId,
      duracao_ms: t(),
      extra: { tamanho_bytes: buf.byteLength, mime: contentType },
    });
  } catch (err) {
    const motivo = err instanceof Error ? err.message.slice(0, 140) : "falha desconhecida";
    log({
      funcao: FUNCAO,
      evento: "download_falha",
      status: "erro",
      mensagem_id: p.mensagemId,
      atendimento_id: p.atendimentoId,
      duracao_ms: t(),
      erro_msg: motivo,
    });
    // Marca para o cron de retry futuro.
    const novaMeta = {
      ...p.metaInicial,
      download_falhou: true,
      download_erro_motivo: motivo,
      url_original_zapi: p.urlOriginal,
    };
    await supabase
      .from("mensagens")
      .update({ media_metadata: novaMeta })
      .eq("id", p.mensagemId);
  }
}
