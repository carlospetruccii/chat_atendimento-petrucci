// Leitura do objeto Message da uazapi: tipo, conteúdo e metadados.
//
// Compartilhado porque três caminhos precisam da MESMA interpretação do payload:
// o webhook (chat individual), o registro de mensagens de grupo e o backfill de
// histórico. Divergir aqui significaria a mesma mensagem virando coisas
// diferentes dependendo de por onde entrou.

export type TipoMensagem =
  | "texto"
  | "imagem"
  | "audio"
  | "documento"
  | "video"
  | "sticker"
  | "localizacao"
  | "contato";

// Mapeia messageType (cru da uazapi) para o tipo interno do sistema, por
// substring case-insensitive (os valores exatos da uazapi são incertos).
export function mapMessageType(mt: string | null | undefined): TipoMensagem {
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

export interface MensagemParseada {
  tipo: TipoMensagem;
  content: string | null;
  media_url: string | null;
  media_metadata: Record<string, unknown> | null;
}

// Detecta o tipo de mensagem e extrai conteúdo/metadados do objeto Message
// da uazapi (o `data` do evento). Campos: messageType, text, fileURL,
// buttonOrListid, content (objeto rico). Mantém o MESMO shape interno de saída.
export function parseMensagem(p: Record<string, unknown>): MensagemParseada | null {
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

// Tipos cuja mídia precisa ser persistida no Storage.
export const TIPOS_COM_DOWNLOAD = new Set<TipoMensagem>(["imagem", "audio", "video", "documento", "sticker"]);

export const EXT_FALLBACK: Record<TipoMensagem, string> = {
  imagem: "bin",
  audio: "ogg",
  video: "mp4",
  documento: "bin",
  texto: "txt",
  sticker: "webp",
  localizacao: "txt",
  contato: "vcf",
};

/**
 * Momento em que a mensagem existiu no WhatsApp, em ISO.
 *
 * Importa para a ORDEM da conversa: o eco de um envio pode chegar segundos
 * depois, e o backfill traz mensagens de dias atrás — usar o instante do INSERT
 * colocaria tudo no fim do histórico. Aceita segundos ou milissegundos (a
 * uazapi documenta ms, mas o campo aparece nos dois formatos).
 */
export function dataDaMensagem(p: Record<string, unknown>): string | null {
  const bruto = p.messageTimestamp ?? p.messageTimestampMs ?? p.timestamp;
  const n = typeof bruto === "number"
    ? bruto
    : (typeof bruto === "string" && bruto.trim() !== "" ? Number(bruto) : NaN);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  // Data absurda (relógio errado do lado de lá) não entra no histórico.
  const ano = d.getUTCFullYear();
  if (ano < 2015 || ano > 2100) return null;
  return d.toISOString();
}
