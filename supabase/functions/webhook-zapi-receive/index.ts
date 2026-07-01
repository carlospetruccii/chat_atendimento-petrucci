// Edge Function: webhook-zapi-receive
// Endpoint público chamado pela uazapi para entregar eventos de WhatsApp.
// (O nome da função/pasta e a coluna zapi_message_id são cosméticos e ficam.)
//
// Princípios:
//   - Sempre responde 200 quando o payload é parseável (evita reentrega em loop).
//   - Idempotente via UNIQUE em mensagens.zapi_message_id (guarda o `id` da uazapi).
//   - NÃO consulta bot_ativo: webhook só recebe; quem responde respeita kill switch.
//   - Mídias: persiste imediatamente e, em background, baixa via
//     POST /message/download (ou data.fileURL) e sobe ao Storage.
//
// Validação de origem: segredo na query string (?secret=...) vs UAZAPI_WEBHOOK_SECRET.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { baixarMidiaMensagem } from "../_shared/uazapi-client.ts";

const FUNCAO = "webhook-zapi-receive";
const BUCKET = "mensagens-midia";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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

// Status string da uazapi → enum status_whatsapp_mensagem.
// Os textos exatos são incertos → mapeamento defensivo por SUBSTRING (uppercase).
function mapStatusWhatsapp(s: string | undefined | null): StatusWhatsapp | null {
  if (!s) return null;
  const u = String(s).toUpperCase();
  if (u.includes("DELIVER")) return "entregue";
  if (u.includes("READ") || u.includes("PLAYED")) return "lido";
  if (u.includes("SENT")) return "enviado";
  if (u.includes("FAIL") || u.includes("ERROR")) return "falha_whatsapp";
  return null;
}

// Mapeia messageType (cru da uazapi) para o tipo interno do sistema, por
// substring case-insensitive (os valores exatos da uazapi são incertos).
function mapMessageType(mt: string | null | undefined): TipoMensagem {
  const t = String(mt ?? "").toLowerCase();
  if (t.includes("image")) return "imagem";
  if (t.includes("video")) return "video";
  if (t.includes("audio") || t.includes("ptt")) return "audio";
  if (t.includes("document")) return "documento";
  if (t.includes("sticker")) return "sticker";
  if (t.includes("location")) return "localizacao";
  if (t.includes("contact") || t.includes("vcard")) return "contato";
  // "conversation" / "text" / "extendedText" e fallback desconhecido → texto.
  return "texto";
}

interface ParsedMensagem {
  tipo: TipoMensagem;
  content: string | null;
  media_url: string | null;
  media_metadata: Record<string, unknown> | null;
}

// Detecta o tipo de mensagem e extrai conteúdo/metadados do objeto Message
// da uazapi (o `data` do evento). Campos: messageType, text, fileURL,
// buttonOrListid, content (objeto rico). Mantém o MESMO shape interno de saída.
function parseMensagem(p: Record<string, unknown>): ParsedMensagem | null {
  // Tipo pela combinação messageType + type + mediaType (uazapi manda
  // "Conversation"/"text" para texto e algo com image/video/audio/… para mídia).
  const rawTipo = [p.messageType, p.type, p.mediaType]
    .filter((x) => typeof x === "string" && x)
    .join(" ");
  const texto = typeof p.text === "string" && p.text
    ? (p.text as string)
    : (typeof p.content === "string" ? (p.content as string) : null);
  const fileURL = ([p.fileURL, p.mediaUrl, p.url]
    .find((x) => typeof x === "string" && /^https?:\/\//i.test(x as string)) as string | undefined) ?? null;
  const buttonOrListid =
    typeof p.buttonOrListid === "string" && p.buttonOrListid.trim() !== ""
      ? (p.buttonOrListid as string)
      : null;

  // Resposta interativa (lista/botão da triagem): tratar como TEXTO, usando o
  // título da opção (text) para o matching da triagem funcionar, e guardar o
  // id selecionado em media_metadata (replicando o tratamento antigo).
  if (buttonOrListid) {
    return {
      tipo: "texto",
      content: texto ?? "",
      media_url: null,
      media_metadata: {
        kind: "list_reply",
        selected_id: buttonOrListid,
        source: "uazapi_interactive",
      },
    };
  }

  const tipo = mapMessageType(rawTipo);

  // Conteúdo rico da uazapi para mídia (URL .enc, mimetype, fileName, seconds…).
  const c = (p.content && typeof p.content === "object")
    ? (p.content as Record<string, unknown>)
    : {};
  const mime = typeof c.mimetype === "string" ? (c.mimetype as string) : null;
  const fileName = typeof c.fileName === "string"
    ? (c.fileName as string)
    : (typeof c.title === "string" ? (c.title as string) : null);
  // media_url precisa ser NÃO-NULO (constraint mensagens_media_url_chk). A URL real
  // do WhatsApp é criptografada (.enc) e é baixada via /message/download em background;
  // usamos um placeholder que NÃO é http (o download vai direto pela API) — depois
  // substituído pelo caminho no bucket.
  const mediaUrlInicial = fileURL ?? "pending:uazapi";

  switch (tipo) {
    case "imagem":
    case "video":
      return { tipo, content: texto ?? null, media_url: mediaUrlInicial, media_metadata: { mime_type: mime } };
    case "audio":
      return {
        tipo,
        content: null,
        media_url: mediaUrlInicial,
        media_metadata: { mime_type: mime, duracao_seg: typeof c.seconds === "number" ? (c.seconds as number) : null },
      };
    case "sticker":
      return { tipo, content: null, media_url: mediaUrlInicial, media_metadata: { mime_type: mime } };
    case "documento":
      return { tipo, content: texto ?? null, media_url: mediaUrlInicial, media_metadata: { mime_type: mime, file_name: fileName } };
    case "localizacao": {
      const content = (p.content ?? null) as Record<string, unknown> | null;
      const latitude = (content?.latitude ?? content?.degreesLatitude ?? null) as number | null;
      const longitude = (content?.longitude ?? content?.degreesLongitude ?? null) as number | null;
      const address =
        (typeof content?.address === "string" ? content.address : null) ?? texto ?? null;
      return {
        tipo,
        content: address,
        media_url: null,
        media_metadata: { latitude, longitude },
      };
    }
    case "contato": {
      const content = (p.content ?? null) as Record<string, unknown> | null;
      const displayName =
        (typeof content?.displayName === "string" ? content.displayName : null) ?? texto ?? null;
      const vcard = (typeof content?.vcard === "string" ? content.vcard : null) ??
        (typeof content?.vCard === "string" ? content.vCard : null) ?? null;
      return {
        tipo,
        content: displayName,
        media_url: null,
        media_metadata: { vcard },
      };
    }
    case "texto":
    default:
      // Mensagem de texto (conversation/text/extendedText) ou fallback.
      // Só descarta se não há absolutamente nenhum texto (evita persistir vazio
      // de eventos que não são mensagem de fato).
      if (texto == null) return null;
      return { tipo: "texto", content: texto, media_url: null, media_metadata: null };
  }
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

// Normaliza número para E.164 com '+'. Aceita "<numero>@s.whatsapp.net",
// "@c.us", "@lid" ou dígitos puros — extrai só os dígitos e prefixa '+'.
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

// Detecta se o chatid da uazapi é LID (não E.164). Regra composta:
//  - sufixo @lid → LID
//  - sufixo @g.us → grupo (não LID, tratado pelo guard de grupo)
//  - se sender_lid existe e não há telefone (sender_pn) → LID
//  - caso contrário, assume E.164.
function ehLid(
  chatid: string | null | undefined,
  senderLid: string | null | undefined,
  senderPn: string | null | undefined,
): boolean {
  const s = chatid ? String(chatid) : "";
  if (s.includes("@lid")) return true;
  if (s.includes("@g.us")) return false;
  // Sem telefone resolvível e com LID disponível → caminho LID.
  const temPn = senderPn && String(senderPn).replace(/\D/g, "") !== "";
  const temLid = senderLid && String(senderLid).replace(/\D/g, "") !== "";
  if (!temPn && temLid) return true;
  return false;
}

function extrairLid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).split("@")[0];
  const digits = s.replace(/\D/g, "");
  return digits || null;
}

function ehGrupo(data: Record<string, unknown>): boolean {
  if ((data as { isGroup?: unknown }).isGroup === true) return true;
  const chatid = (data as { chatid?: string }).chatid;
  return typeof chatid === "string" && chatid.includes("@g.us");
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
  data: Record<string, unknown>,
  supabase: ReturnType<typeof getSupabaseAdmin>,
  opts: { permitirCriar: boolean; senderName: string | null; preferChatid?: boolean },
): Promise<ClienteResolvido | ResolverErro> {
  const chatid = (data.chatid as string | undefined) ?? null;
  // Em mensagens fromMe (enviadas pelo celular da empresa) o REMETENTE é a
  // empresa; o cliente é o destinatário, que vem no chatid. Nesse caso
  // ignoramos sender_pn/sender_lid (dados do nosso próprio número) e
  // identificamos o cliente exclusivamente pelo chatid.
  const senderPn = opts.preferChatid ? null : ((data.sender_pn as string | undefined) ?? null);
  const senderLid = opts.preferChatid ? null : ((data.sender_lid as string | undefined) ?? null);
  // LID normalizado: preferir sender_lid; senão o chatid quando for @lid.
  const chatLidNorm = extrairLid(senderLid) ??
    (chatid && String(chatid).includes("@lid") ? extrairLid(chatid) : null);

  if (!ehLid(chatid, senderLid, senderPn)) {
    // Caminho E.164. Número vem de sender_pn ou do chatid (@s.whatsapp.net/@c.us).
    const numero = normalizarNumero(senderPn ?? chatid);
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
  const lid = chatLidNorm ??
    (chatid && String(chatid).includes("@lid") ? extrairLid(chatid) : null);
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

  // 1) A validação de origem é feita APÓS o parse do corpo, comparando o `token`
  // que a uazapi envia no payload com o secret UAZAPI_TOKEN (ver 2b). A uazapi
  // inclui o token da instância no corpo — mais confiável que query string.

  // 2) Parse do envelope.
  let envelope: Record<string, unknown>;
  try {
    envelope = (await req.json()) as Record<string, unknown>;
  } catch {
    log({ funcao: FUNCAO, evento: "payload_invalido", status: "erro", duracao_ms: cron() });
    // 200 mesmo assim para a uazapi não reenviar payload quebrado.
    return jsonResponse({ ok: true, ignorado: "payload_invalido" });
  }

  // 2b) Validação de origem: a uazapi inclui o token da instância no corpo
  // (`token`). Conferimos contra o secret UAZAPI_TOKEN — é o jeito real como a
  // uazapi entrega e não depende de query string.
  const expectedToken = Deno.env.get("UAZAPI_TOKEN");
  const bodyToken = typeof envelope.token === "string" ? (envelope.token as string) : null;
  if (expectedToken && bodyToken !== expectedToken) {
    log({ funcao: FUNCAO, evento: "token_invalido", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }

  // Formato REAL da uazapi (confirmado em produção): envelope
  //   { EventType, chat, message, owner, token, instanceName, ... }
  // O tipo do evento vem em `EventType`; a mensagem em `message`.
  const eventStr = ((envelope.EventType ?? envelope.event) as string | undefined) ?? null;
  const payload = ((envelope.message && typeof envelope.message === "object")
    ? envelope.message
    : (envelope.data && typeof envelope.data === "object")
    ? envelope.data
    : envelope) as Record<string, unknown>;

  // Conexão: apenas logar, sem ação no banco.
  const eventLc = (eventStr ?? "").toLowerCase();
  if (eventLc === "connection") {
    log({
      funcao: FUNCAO,
      evento: "uazapi_connection",
      status: "ok",
      extra: { event: eventStr },
    });
    return jsonResponse({ ok: true });
  }

  // Detecção de rota. Eventos de status: "messages_update"/"status". Mensagem
  // nova: "messages"/"message". Se o `event` não bater, roteia pela forma do
  // `data`: cara de mensagem (tem messageType/text/chatid) → mensagem;
  // só id+status → status.
  const statusRaw =
    (payload.status as string | undefined) ??
      (payload.messageStatus as string | undefined) ??
      null;
  const temCaraDeMensagem = payload.messageType != null ||
    typeof payload.text === "string" ||
    payload.chatid != null ||
    payload.fromMe != null;
  const ehEventoStatus = eventLc === "messages_update" || eventLc === "status" ||
    (!eventLc.startsWith("message") && !temCaraDeMensagem && statusRaw != null);
  const ehEventoMensagem = eventLc === "messages" || eventLc === "message" ||
    (!ehEventoStatus && temCaraDeMensagem);

  const fromMe = payload.fromMe === true;
  const wasSentByApi = payload.wasSentByApi === true;
  const zapiMessageId =
    (payload.id as string | undefined) ??
      (payload.messageid as string | undefined) ??
      null;

  // `quoted`: id (owner:messageid) da mensagem citada. Resolve para nossa
  // mensagens.id correspondente, se existir.
  const quotedId =
    (typeof payload.quoted === "string" ? (payload.quoted as string) : null) ??
      null;
  let replyToMessageId: string | null = null;
  if (quotedId) {
    const { data: refRow } = await supabase
      .from("mensagens")
      .select("id")
      .eq("zapi_message_id", quotedId)
      .maybeSingle();
    if (refRow?.id) replyToMessageId = refRow.id as string;
  }

  // Bring-up/observabilidade: log estruturado sem dados sensíveis (nada de
  // texto, número completo ou tokens) para confirmar o formato real da uazapi.
  log({
    funcao: FUNCAO,
    evento: "uazapi_webhook_recebido",
    status: "ok",
    extra: {
      event: eventStr,
      message_type: (payload.messageType as string | undefined) ?? null,
      from_me: fromMe,
      was_sent_by_api: wasSentByApi,
      is_group: (payload as { isGroup?: unknown }).isGroup === true,
      has_file: typeof payload.fileURL === "string" && !!payload.fileURL,
      has_button_or_list: typeof payload.buttonOrListid === "string" &&
        (payload.buttonOrListid as string).trim() !== "",
      status_raw: statusRaw,
    },
  });

  // Segurança: mensagens enviadas pela própria API voltam com wasSentByApi=true.
  // A config do webhook já as exclui, mas ignoramos aqui também (evita loop).
  if (wasSentByApi) {
    log({
      funcao: FUNCAO,
      evento: "evento_ignorado",
      status: "ok",
      extra: { motivo: "was_sent_by_api", event: eventStr },
    });
    return jsonResponse({ ok: true });
  }

  // Guard: mensagens de grupo são descartadas explicitamente. chatid termina
  // em "@g.us" e violaria o CHECK E.164 ao tentar criar cliente.
  if (ehEventoMensagem && ehGrupo(payload)) {
    log({
      funcao: FUNCAO,
      evento: "evento_ignorado",
      status: "ok",
      extra: { motivo: "mensagem_grupo", event: eventStr },
    });
    return jsonResponse({ ok: true });
  }

  try {
    // 3) Roteamento por tipo de evento.

    // 3a) Status de mensagem outbound (delivered/read/...).
    if (ehEventoStatus) {
      const novoStatus = mapStatusWhatsapp(statusRaw);
      const ids: string[] = zapiMessageId ? [zapiMessageId] : [];

      if (!novoStatus || ids.length === 0) {
        log({
          funcao: FUNCAO,
          evento: "status_ignorado",
          status: "ok",
          extra: { event: eventStr, status_raw: statusRaw },
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
          extra: { motivo: "from_me_tipo_nao_suportado", event: eventStr },
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

      // Cliente = o DESTINATÁRIO (chatid), pois em fromMe o remetente é a
      // empresa. permitirCriar: se você iniciou uma conversa nova pelo celular
      // com alguém que ainda não é cliente, criamos o cliente aqui.
      const resolved = await resolverClienteIdent(payload, supabase, {
        permitirCriar: true,
        senderName: null,
        preferChatid: true,
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
          // Só cai aqui em chat LID sem E.164 conhecido: não dá para criar
          // cliente (CHECK exige E.164). Fica visível quando o cliente responder.
          log({
            funcao: FUNCAO,
            evento: "evento_ignorado",
            status: "ok",
            extra: {
              motivo: "from_me_lid_sem_e164",
              via_tentada: resolved.via_tentada,
              chat_lid_mask: mascararLid(
                extrairLid((payload.chatid as string | undefined) ?? null),
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

      // Procura atendimento ativo desse cliente (para anexar a mensagem nele).
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

      // #2 — Conversa iniciada pelo celular com cliente sem atendimento aberto:
      // cria um atendimento visível para admins/supervisão. status 'pendente'
      // (NÃO 'em_triagem') para o bot não iniciar triagem; sem dono, então
      // aparece na Inbox de quem vê tudo e na tela de Pendentes.
      if (!atendExt) {
        // Departamento é obrigatório fora de em_triagem (CHECK do banco).
        // Preferência: config 'triagem_departamento_default' → "Outros"
        // (catch-all) → primeiro departamento ativo.
        const { data: cfgDept } = await supabase
          .from("system_config")
          .select("valor")
          .eq("chave", "triagem_departamento_default")
          .maybeSingle();
        let deptExt = (cfgDept?.valor ?? null) as string | null;
        if (!deptExt) {
          const { data: dOutros } = await supabase
            .from("departments")
            .select("id")
            .eq("ativo", true)
            .ilike("nome", "outros")
            .limit(1)
            .maybeSingle();
          deptExt = (dOutros?.id as string | undefined) ?? null;
        }
        if (!deptExt) {
          const { data: dPrim } = await supabase
            .from("departments")
            .select("id")
            .eq("ativo", true)
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();
          deptExt = (dPrim?.id as string | undefined) ?? null;
        }
        if (!deptExt) {
          log({
            funcao: FUNCAO,
            evento: "externo_sem_departamento",
            status: "erro",
            client_id: clienteExt.id,
            extra: { motivo: "nenhum_departamento_ativo" },
          });
          return jsonResponse({ ok: true });
        }
        const agoraIso = new Date().toISOString();
        const { data: novoExt, error: errNovoExt } = await supabase
          .from("atendimentos")
          .insert({
            client_id: clienteExt.id,
            status: "pendente",
            current_department_id: deptExt,
            assigned_to: null,
            subject_id: null,
            triagem_estagio: "concluida",
            triagem_started_at: agoraIso,
            triagem_finished_at: agoraIso,
          })
          .select("id, current_department_id")
          .single();
        if (errNovoExt || !novoExt) {
          log({
            funcao: FUNCAO,
            evento: "criar_atendimento_externo_erro",
            status: "erro",
            client_id: clienteExt.id,
            erro_msg: errNovoExt?.message,
          });
          return jsonResponse({ ok: true });
        }
        atendExt = novoExt as { id: string; current_department_id: string | null };
        await supabase.from("timeline_events").insert({
          atendimento_id: atendExt.id,
          tipo_evento: "iniciado_atendimento",
          actor_user_id: null,
          to_department_id: atendExt.current_department_id,
          payload: { origem: "mensagem_externa_celular" },
        });
        log({
          funcao: FUNCAO,
          evento: "atendimento_externo_criado",
          status: "ok",
          atendimento_id: atendExt.id,
          client_id: clienteExt.id,
          extra: { dept: atendExt.current_department_id },
        });
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
      if (TIPOS_COM_DOWNLOAD.has(parsedExt.tipo)) {
        const tarefa = baixarESalvarMidia({
          mensagemId: mensagemExtId,
          atendimentoId: atendExt.id,
          clientId: clienteExt.id,
          zapiMessageId,
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
          event: eventStr,
          message_type: (payload.messageType as string | undefined) ?? null,
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
    const senderName = (payload.senderName as string | undefined) ?? null;

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
          extra: {
            telefone_mask: mascararNumero(
              (payload.sender_pn as string | undefined) ??
                (payload.chatid as string | undefined),
            ),
          },
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
            chat_lid_mask: mascararLid((payload as { sender_lid?: string }).sender_lid ?? null),
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
    if (TIPOS_COM_DOWNLOAD.has(parsed.tipo)) {
      const tarefa = baixarESalvarMidia({
        mensagemId,
        atendimentoId: atend.id,
        clientId: cliente.id,
        zapiMessageId,
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
    // 200 mesmo assim — a uazapi não deve reenviar.
    return jsonResponse({ ok: true, erro_interno: true });
  }
});

// --- Helpers ---

interface DownloadParams {
  mensagemId: string;
  atendimentoId: string;
  clientId: string;
  // `id` (owner:messageid) da mensagem uazapi — usado no POST /message/download.
  zapiMessageId: string;
  // URL direta da mídia (data.fileURL), quando presente — tentada primeiro.
  urlOriginal: string | null;
  tipo: TipoMensagem;
  metaInicial: Record<string, unknown>;
}

// Baixa os bytes da mídia: tenta data.fileURL (http/https) direto; se falhar,
// cai para POST /message/download da uazapi (retorna base64).
async function obterBytesMidia(
  urlOriginal: string | null,
  zapiMessageId: string,
): Promise<{ buf: Uint8Array; contentType: string | null; fonte: string }> {
  // 1) /message/download — fonte confiável (bytes DECODIFICADOS via base64Data).
  try {
    const res = await baixarMidiaMensagem(zapiMessageId);
    if (res.base64) {
      const bin = atob(res.base64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      if (buf.byteLength > 0) {
        return { buf, contentType: res.mimetype ?? null, fonte: "message_download_base64" };
      }
    }
    // 2) fileURL hospedada e decodificada pela uazapi (não é .enc).
    if (res.url && /^https?:\/\//i.test(res.url)) {
      const r = await fetch(res.url);
      if (r.ok) {
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.byteLength > 0) {
          return { buf, contentType: r.headers.get("content-type") ?? res.mimetype ?? null, fonte: "message_download_url" };
        }
      }
    }
  } catch {
    // cai para a tentativa direta abaixo
  }

  // 3) Último recurso: urlOriginal, só se for http (a .enc não serve; placeholder é ignorado).
  if (urlOriginal && /^https?:\/\//i.test(urlOriginal)) {
    const resp = await fetch(urlOriginal);
    if (resp.ok) {
      const buf = new Uint8Array(await resp.arrayBuffer());
      if (buf.byteLength > 0) {
        return { buf, contentType: resp.headers.get("content-type"), fonte: "url_original" };
      }
    }
  }
  throw new Error("não foi possível obter os bytes da mídia (/message/download)");
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
    const { buf, contentType: ctDetectado, fonte } = await obterBytesMidia(
      p.urlOriginal,
      p.zapiMessageId,
    );
    const contentType = ctDetectado ??
      (p.metaInicial.mime_type as string | null) ?? "application/octet-stream";

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
      extra: { tamanho_bytes: buf.byteLength, mime: contentType, fonte },
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
