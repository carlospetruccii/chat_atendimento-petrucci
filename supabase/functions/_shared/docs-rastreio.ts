// Regras puras da aba Docs (número financeiro) que o webhook e as funções de
// envio precisam concordar. Testadas em docs-rastreio.test.ts.

/**
 * Marca que os nossos envios pelo número financeiro levam na uazapi
 * (`track_source`). O `track_id` é o id da NOSSA linha em docs_mensagens, e os
 * dois voltam no eco — é o que permite reconhecer o eco com certeza, sem
 * comparar conteúdo. Importa porque a instância é compartilhada: um documento
 * do outro sistema também chega como `fromMe + wasSentByApi`, e adotá-lo por
 * engano gravaria o id DELE na nossa linha (e "apagar" a nossa apagaria o dele).
 */
export const TRACK_SOURCE_DOCS = "chatatendimento-docs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EcoDocs =
  | { tipo: "nosso"; mensagemId: string }
  /** Marcado por outro (ou sem marca num payload que traz os campos): não é nosso. */
  | { tipo: "outro" }
  /** O payload nem traz os campos de rastreio: não dá para saber pela marca. */
  | { tipo: "sem_rastreio" };

export function classificarEcoDocs(payload: Record<string, unknown>): EcoDocs {
  const temCampos = "track_source" in payload || "track_id" in payload;
  if (!temCampos) return { tipo: "sem_rastreio" };
  const origem = typeof payload.track_source === "string" ? payload.track_source.trim() : "";
  const id = typeof payload.track_id === "string" ? payload.track_id.trim() : "";
  if (origem === TRACK_SOURCE_DOCS && UUID.test(id)) {
    return { tipo: "nosso", mensagemId: id.toLowerCase() };
  }
  return { tipo: "outro" };
}

/**
 * Conversa individual: número (@s.whatsapp.net / @c.us) ou LID. Canal
 * (@newsletter), status (@broadcast) e grupo (@g.us) não entram no Docs — um
 * id de canal tem só dígitos e viraria "cliente" lixo.
 */
export function chatIndividualValido(chatid: unknown): boolean {
  return typeof chatid === "string" && /^[0-9]+(:[0-9]+)?@(s\.whatsapp\.net|c\.us|lid)$/i.test(chatid.trim());
}

/**
 * A URL de mídia que vem no payload do webhook só é usada se for https de um
 * host do WhatsApp. O número financeiro recebe mensagem de qualquer pessoa: sem
 * isto, uma mídia forjada faria a função buscar URL arbitrária (SSRF).
 */
export function urlMidiaConfiavel(url: unknown): string | null {
  if (typeof url !== "string") return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const doWhatsapp = host === "whatsapp.net" || host.endsWith(".whatsapp.net");
  return doWhatsapp ? u.toString() : null;
}
