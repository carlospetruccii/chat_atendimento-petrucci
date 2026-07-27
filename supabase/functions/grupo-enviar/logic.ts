// Validação pura do payload de envio para grupo. Sem I/O — testado em
// logic.test.ts. Uma função só para os quatro formatos (texto, imagem, vídeo,
// documento, áudio) porque as regras são quase iguais e duplicá-las por tipo já
// se provou fonte de divergência nas funções de envio individuais.

export type TipoEnvioGrupo = "texto" | "image" | "video" | "document" | "audio";

export const MAX_BYTES_ANEXO = 16 * 1024 * 1024; // 16 MB (limite da uazapi)
export const MAX_CHARS_TEXTO = 4096;
export const MAX_CHARS_CAPTION = 1024;

const TIPOS_VALIDOS: ReadonlySet<string> = new Set<TipoEnvioGrupo>([
  "texto",
  "image",
  "video",
  "document",
  "audio",
]);

/** Tipo interno do banco (enum tipo_mensagem) para cada formato de envio. */
export const TIPO_MENSAGEM_POR_ENVIO: Record<TipoEnvioGrupo, string> = {
  texto: "texto",
  image: "imagem",
  video: "video",
  document: "documento",
  audio: "audio",
};

export interface PayloadEnvioGrupo {
  grupo_id?: unknown;
  tipo?: unknown;
  content?: unknown;
  arquivo_base64?: unknown;
  mime_type?: unknown;
  nome_arquivo?: unknown;
  duracao_seg?: unknown;
  reply_to_message_id?: unknown;
}

export interface EnvioValidado {
  grupoId: string;
  tipo: TipoEnvioGrupo;
  /** Texto da mensagem (tipo 'texto') ou legenda da mídia. */
  content: string | null;
  arquivoBase64: string | null;
  mimeType: string;
  nomeArquivo: string;
  duracaoSeg: number | null;
  replyToMessageId: string | null;
}

export type ResultadoValidacao =
  | { ok: true; envio: EnvioValidado }
  | { ok: false; erro: string; status: number };

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Tamanho aproximado dos bytes por trás de uma string base64. */
export function bytesAproximadosDeBase64(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}

export function validarEnvioGrupo(p: PayloadEnvioGrupo): ResultadoValidacao {
  const grupoId = texto(p.grupo_id);
  const tipoRaw = texto(p.tipo);

  if (!grupoId) return { ok: false, erro: "grupo_id_obrigatorio", status: 400 };
  if (!tipoRaw || !TIPOS_VALIDOS.has(tipoRaw)) {
    return { ok: false, erro: "tipo_invalido", status: 400 };
  }
  const tipo = tipoRaw as TipoEnvioGrupo;

  const ehMidia = tipo !== "texto";
  const arquivoBase64 = texto(p.arquivo_base64);
  const conteudoBruto = typeof p.content === "string" ? p.content.trim() : "";

  if (tipo === "texto") {
    if (conteudoBruto === "") return { ok: false, erro: "mensagem_vazia", status: 400 };
    if (conteudoBruto.length > MAX_CHARS_TEXTO) {
      return { ok: false, erro: "mensagem_muito_longa", status: 413 };
    }
  }

  if (ehMidia) {
    if (!arquivoBase64) return { ok: false, erro: "arquivo_obrigatorio", status: 400 };
    if (bytesAproximadosDeBase64(arquivoBase64) > MAX_BYTES_ANEXO) {
      return { ok: false, erro: "arquivo_muito_grande", status: 413 };
    }
  }

  // Áudio é nota de voz: nunca leva legenda (o WhatsApp ignora e a bolha ficaria
  // com texto fantasma no nosso histórico).
  const content = tipo === "texto"
    ? conteudoBruto
    : tipo === "audio"
      ? null
      : conteudoBruto.slice(0, MAX_CHARS_CAPTION) || null;

  const duracao = typeof p.duracao_seg === "number" && Number.isFinite(p.duracao_seg)
    ? Math.max(0, Math.round(p.duracao_seg))
    : null;

  return {
    ok: true,
    envio: {
      grupoId,
      tipo,
      content,
      arquivoBase64,
      mimeType: texto(p.mime_type) ?? "application/octet-stream",
      nomeArquivo: (texto(p.nome_arquivo) ?? "arquivo").slice(0, 200),
      duracaoSeg: tipo === "audio" ? duracao : null,
      replyToMessageId: texto(p.reply_to_message_id),
    },
  };
}

/** Extensão do arquivo: do nome, senão do mime, senão fallback por tipo. */
export function deduzirExtensao(nome: string, mime: string, tipo: TipoEnvioGrupo): string {
  const doNome = nome.match(/\.([a-zA-Z0-9]{1,8})$/);
  if (doNome) return doNome[1].toLowerCase();
  const porMime: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/webm": "webm",
    "application/pdf": "pdf",
  };
  const base = mime.split(";")[0].trim().toLowerCase();
  if (porMime[base]) return porMime[base];
  const fallback: Record<TipoEnvioGrupo, string> = {
    texto: "txt",
    image: "bin",
    video: "mp4",
    document: "bin",
    audio: "ogg",
  };
  return fallback[tipo];
}
