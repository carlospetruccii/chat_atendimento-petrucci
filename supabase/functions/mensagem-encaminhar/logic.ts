// Lógica pura de "encaminhar mensagem" — sem I/O, testada em logic.test.ts.
//
// Elegibilidade: diferente de editar/apagar (ver _shared/janelas-whatsapp.ts),
// encaminhar NÃO tem janela de tempo e vale tanto para mensagens inbound
// quanto outbound — no WhatsApp real dá para encaminhar qualquer mensagem,
// inclusive as que o cliente mandou. Mantido como função própria (não entra
// no núcleo compartilhado de janelas-whatsapp.ts) porque as regras não têm
// nada em comum com aquelas além do nome do arquivo-irmão no frontend
// (src/lib/mensagem-encaminhar.ts) — mesma lógica, duplicada de propósito por
// não precisar do aparato de paridade textual que apagar/editar exigem.

export type MotivoBloqueadoEncaminhar =
  /** Já apagada — não há mais conteúdo para encaminhar. */
  | "ja_apagada"
  /** Aviso interno do sistema, não é conteúdo real do WhatsApp. */
  | "aviso_interno"
  /** Menu/lista interativa: não existe como mensagem enviável. */
  | "menu_interativo"
  /** Tipo sem suporte a envio (ex.: figurinha, localização, contato). */
  | "tipo_nao_suportado"
  /** Mídia que nunca chegou ao bucket (download falhou ou ainda não terminou). */
  | "midia_indisponivel";

export interface ElegibilidadeEncaminhar {
  pode: boolean;
  motivo?: MotivoBloqueadoEncaminhar;
}

export interface MensagemEncaminhavel {
  apagadaEm: string | null;
  senderType: string;
  tipo: string;
  ehListaOpcoes?: boolean;
  /**
   * Mídia já no bucket (tem storage_path). Só olhado para tipos de mídia — o
   * envio encaminhado copia o arquivo do bucket, então mensagem com
   * `download_falhou` (ou ainda baixando) não tem o que encaminhar.
   */
  midiaPronta?: boolean;
}

/** Tipos que o envio (enviarTexto/enviarMidia) sabe mandar para o WhatsApp. */
export const TIPOS_ENCAMINHAVEIS: ReadonlySet<string> = new Set([
  "texto",
  "imagem",
  "audio",
  "video",
  "documento",
]);

export function avaliarEncaminhar(msg: MensagemEncaminhavel): ElegibilidadeEncaminhar {
  if (msg.apagadaEm) return { pode: false, motivo: "ja_apagada" };
  if (msg.senderType === "sistema") return { pode: false, motivo: "aviso_interno" };
  if (msg.ehListaOpcoes) return { pode: false, motivo: "menu_interativo" };
  if (!TIPOS_ENCAMINHAVEIS.has(msg.tipo)) return { pode: false, motivo: "tipo_nao_suportado" };
  if (msg.tipo !== "texto" && msg.midiaPronta !== true) {
    return { pode: false, motivo: "midia_indisponivel" };
  }
  return { pode: true };
}

/** Mapeia o enum interno (tipo_mensagem) para o TipoMidia que uazapi-client espera. */
export type TipoMidiaEncaminhavel = "image" | "audio" | "video" | "document";

export const TIPO_PARA_UAZAPI: Record<string, TipoMidiaEncaminhavel> = {
  imagem: "image",
  audio: "audio",
  video: "video",
  documento: "document",
};

const BUCKET = "mensagens-midia";

export interface MediaMetadataOriginal {
  storage_path?: unknown;
  mime_type?: unknown;
  file_name?: unknown;
  extensao?: unknown;
  tamanho_bytes?: unknown;
  duracao_seg?: unknown;
}

export interface MediaMetadataEncaminhada {
  storage_path: string;
  bucket: string;
  mime_type?: string;
  file_name?: string;
  extensao?: string;
  tamanho_bytes?: number;
  duracao_seg?: number;
  /** Rastro de auditoria: de qual mensagem original isto foi encaminhado. */
  encaminhada_de_mensagem_id: string;
}

/** Extensão do arquivo original: do metadata, senão do próprio storage_path. */
export function extensaoDoOriginal(
  meta: MediaMetadataOriginal,
  storagePathOriginal: string,
): string {
  if (typeof meta.extensao === "string" && meta.extensao.trim()) return meta.extensao.trim();
  const m = storagePathOriginal.match(/\.([a-zA-Z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : "bin";
}

/**
 * Novo storage_path para a CÓPIA do arquivo no bucket. NUNCA reaproveita o
 * path da origem: se a mensagem original for apagada depois (mensagem-acao
 * remove o arquivo do bucket), a cópia encaminhada tem que continuar viva.
 */
export function novoStoragePath(
  atendimentoIdDestino: string,
  uuid: string,
  extensao: string,
): string {
  return `encaminhadas/${atendimentoIdDestino}/${uuid}.${extensao}`;
}

/** Monta o media_metadata da mensagem encaminhada a partir do original. */
export function metadataEncaminhada(params: {
  original: MediaMetadataOriginal;
  novoPath: string;
  mensagemOrigemId: string;
}): MediaMetadataEncaminhada {
  const { original, novoPath, mensagemOrigemId } = params;
  const out: MediaMetadataEncaminhada = {
    storage_path: novoPath,
    bucket: BUCKET,
    encaminhada_de_mensagem_id: mensagemOrigemId,
  };
  if (typeof original.mime_type === "string") out.mime_type = original.mime_type;
  if (typeof original.file_name === "string") out.file_name = original.file_name;
  if (typeof original.extensao === "string") out.extensao = original.extensao;
  if (typeof original.tamanho_bytes === "number") out.tamanho_bytes = original.tamanho_bytes;
  if (typeof original.duracao_seg === "number") out.duracao_seg = original.duracao_seg;
  return out;
}
