// Decisões puras da importação de conversas (sem banco e sem rede).

import { fotoDoChat } from "../_shared/foto-perfil.ts";

/** Chat da uazapi que vira conversa no sistema. */
export interface AlvoChat {
  /** JID como a uazapi conhece (usado no /message/find). */
  chatid: string;
  /** E.164 com '+', formato de clients.numero_whatsapp. */
  numero: string;
  lid: string | null;
  nome: string | null;
  foto: string | null;
  ultimaMsgMs: number | null;
}

export interface AtendimentoRef {
  id: string;
  created_at: string;
  current_department_id: string | null;
}

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function digitos(v: unknown): string {
  return texto(v).split("@")[0].split(":")[0].replace(/\D/g, "");
}

/** Timestamp da uazapi (segundos ou ms, número ou string) → ms. */
export function tsParaMs(v: unknown): number | null {
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() ? Number(v) : NaN);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** Nome utilizável do contato — ignora vazio e valor que é só telefone. */
export function nomeDoChat(chat: Record<string, unknown>): string | null {
  const candidatos = [chat.wa_contactName, chat.wa_name, chat.name, chat.lead_fullName, chat.lead_name];
  for (const c of candidatos) {
    const t = texto(c);
    if (t && !/^\+?\d[\d\s()-]*$/.test(t)) return t.slice(0, 120);
  }
  return null;
}

/**
 * Converte um chat da /chat/find em alvo de importação, ou null quando não é
 * conversa com cliente: grupo, status/broadcast, canal, sem telefone válido, ou
 * número da lista de exclusão (o próprio número e os de colaboradores — o chat
 * deles é cheio de aviso interno do sistema, não conversa com cliente).
 */
export function alvoDoChat(
  chat: Record<string, unknown>,
  excluidos: ReadonlySet<string>,
): AlvoChat | null {
  const chatid = texto(chat.wa_chatid);
  if (!chatid) return null;
  if (chat.wa_isGroup === true) return null;
  if (/@(g\.us|broadcast|newsletter)$/i.test(chatid)) return null;

  const ehLid = /@lid$/i.test(chatid);
  const d = ehLid ? digitos(chat.phone) : digitos(chatid);
  if (!/^[1-9]\d{7,14}$/.test(d)) return null;
  if (excluidos.has(d)) return null;

  const lid = ehLid ? digitos(chatid) : digitos(chat.wa_chatlid);
  return {
    chatid,
    numero: `+${d}`,
    lid: lid || null,
    nome: nomeDoChat(chat),
    foto: fotoDoChat(chat),
    ultimaMsgMs: tsParaMs(chat.wa_lastMsgTimestamp),
  };
}

/**
 * Atendimento onde uma mensagem do instante `quandoIso` encaixa: o último
 * criado até aquele momento. `lista` em ordem crescente de created_at.
 */
export function atendimentoDoMomento(
  lista: readonly AtendimentoRef[],
  quandoIso: string,
): AtendimentoRef | null {
  const q = Date.parse(quandoIso);
  let achado: AtendimentoRef | null = null;
  for (const a of lista) {
    if (Date.parse(a.created_at) <= q) achado = a;
    else break;
  }
  return achado;
}
