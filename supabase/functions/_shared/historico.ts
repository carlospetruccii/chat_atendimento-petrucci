// Decisões puras da importação de histórico antigo (sem banco e sem rede).
//
// Compartilhado entre historico-solicitar (quem pede) e webhook-historico (quem
// grava): as duas pontas precisam concordar sobre o que é o id de uma mensagem e
// o que está dentro da janela pedida. Divergir aqui significa pedir uma coisa e
// gravar outra.

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Ids pelos quais esta mensagem pode já estar gravada.
 *
 * O webhook grava o formato composto `owner:messageid` (conferido em produção),
 * mas as rotas de leitura devolvem `id`, `messageid` e `owner` separados e a doc
 * da uazapi é ambígua sobre o que vem em `id`. Conferimos contra TODAS as formas
 * — errar aqui significaria gravar de novo uma mensagem que já está na conversa,
 * e `mensagens` não aceita DELETE.
 */
export function idsPossiveis(
  m: Record<string, unknown>,
): { preferido: string | null; todos: string[] } {
  const owner = texto(m.owner);
  const messageid = texto(m.messageid);
  const id = texto(m.id);
  const composto = owner && messageid ? `${owner}:${messageid}` : "";
  const preferido = composto || (id.includes(":") ? id : "") || id || messageid || "";
  const todos = [...new Set([composto, id, messageid].filter((v) => v !== ""))];
  return { preferido: preferido || null, todos };
}

/**
 * `messageid` cru, sem o prefixo `owner:`.
 *
 * Guardamos `owner:messageid` em `mensagens.zapi_message_id`, mas o
 * /message/history-sync espera o messageid puro no campo `messageid` (é a âncora
 * de onde ele anda para trás). Mandar o composto faz o pedido não achar âncora.
 */
export function messageidCru(zapiMessageId: string | null | undefined): string | null {
  const v = texto(zapiMessageId);
  if (!v) return null;
  const idx = v.lastIndexOf(":");
  const cru = idx >= 0 ? v.slice(idx + 1).trim() : v;
  return cru || null;
}

export function inteiroNoIntervalo(v: unknown, padrao: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** JID de chat individual a partir de um telefone em qualquer formatação. */
export function chatIdDoNumero(numero: string): string | null {
  const d = String(numero ?? "").replace(/\D/g, "");
  return d ? `${d}@s.whatsapp.net` : null;
}

/** Telefone (dígitos) a partir do JID de chat individual. */
export function numeroDoChatId(chatid: string): string | null {
  const bruto = String(chatid ?? "").split("@")[0].split(":")[0].replace(/\D/g, "");
  return bruto || null;
}

/**
 * A mensagem cabe na janela pedida? `desde` <= quando < `ate`.
 *
 * O teto é EXCLUSIVO de propósito: `ate` é a mensagem mais antiga que já temos,
 * e ela própria não deve ser reimportada.
 */
export function dentroDaJanela(quandoIso: string, desdeIso: string, ateIso: string): boolean {
  const q = Date.parse(quandoIso);
  const d = Date.parse(desdeIso);
  const a = Date.parse(ateIso);
  if (!Number.isFinite(q) || !Number.isFinite(d) || !Number.isFinite(a)) return false;
  return q >= d && q < a;
}

/**
 * Extrai a lista de mensagens de um evento `history` da uazapi.
 *
 * O formato do lote não está fechado na doc (a doc só diz "as mensagens retornam
 * via webhook em eventos do tipo `history`"), então aceitamos as formas
 * plausíveis: array no topo, ou em `messages`/`message`/`data`/`history`, e
 * objeto único. Filtra o que não tem cara de objeto.
 */
export function mensagensDoEventoHistory(envelope: Record<string, unknown>): Record<string, unknown>[] {
  const candidatos: unknown[] = [
    envelope.messages,
    envelope.message,
    envelope.data,
    envelope.history,
    envelope,
  ];
  for (const c of candidatos) {
    if (Array.isArray(c)) {
      const itens = c.filter((m): m is Record<string, unknown> => !!m && typeof m === "object");
      if (itens.length > 0) return itens;
    }
  }
  for (const c of candidatos) {
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const o = c as Record<string, unknown>;
      // Só conta como mensagem se tiver cara de mensagem — o envelope inteiro
      // (com token, EventType, etc.) não é uma mensagem.
      const temCara = o.messageType != null || typeof o.text === "string" ||
        o.chatid != null || o.fromMe != null;
      if (temCara) return [o];
    }
  }
  return [];
}

/** chatid da mensagem, caindo para o chat do envelope quando ela não traz. */
export function chatIdDaMensagem(
  m: Record<string, unknown>,
  envelope: Record<string, unknown>,
): string | null {
  const direto = texto(m.chatid) || texto(m.chatId) || texto(m.chat_id);
  if (direto) return direto;
  const chat = envelope.chat;
  if (chat && typeof chat === "object") {
    const c = chat as Record<string, unknown>;
    const doChat = texto(c.id) || texto(c.wa_chatid) || texto(c.chatid);
    if (doChat) return doChat;
  }
  const sender = texto(m.sender) || texto(m.from);
  return sender || null;
}
