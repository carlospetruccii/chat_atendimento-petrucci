// Decisões puras da importação do histórico do número financeiro (testadas em
// logic.test.ts).

import { chatIndividualValido } from "../_shared/docs-rastreio.ts";

/**
 * A uazapi guarda ~7 dias de mensagens por conversa (medido: nada de 16 dias
 * atrás voltou). Aceita um pouco mais porque o corte dela não é exato — o que
 * não existe mais simplesmente não volta.
 */
export const DIAS_MAX = 10;
const DIAS_PADRAO = 7;
const LIMITE_CHATS_PADRAO = 30;
const LIMITE_CHATS_MAX = 100;

export interface PedidoImportacao {
  dias: number;
  limiteChats: number;
  offset: number;
  /** Só grava com `dry_run: false` explícito (booleano). */
  dryRun: boolean;
}

function inteiro(v: unknown, padrao: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : padrao;
  return Math.min(max, Math.max(min, n));
}

export function validarPedidoImportacao(p: Record<string, unknown>): PedidoImportacao {
  return {
    dias: inteiro(p.dias, DIAS_PADRAO, 1, DIAS_MAX),
    limiteChats: inteiro(p.limite_chats, LIMITE_CHATS_PADRAO, 1, LIMITE_CHATS_MAX),
    offset: inteiro(p.offset, 0, 0, 100_000),
    dryRun: p.dry_run !== false,
  };
}

/** Timestamp da uazapi (segundos ou ms, número ou texto) → ms. */
export function paraMs(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

export interface ChatListado {
  chatid: string;
  ultimaMs: number | null;
}

/** Resposta de POST /chat/find → só conversas individuais (sem grupo/canal/status). */
export function extrairChats(resp: unknown): ChatListado[] {
  const r = resp as Record<string, unknown> | unknown[] | null;
  const lista = Array.isArray(r) ? r : Array.isArray(r?.chats) ? r.chats as unknown[] : [];
  return lista
    .map((c) => (c ?? {}) as Record<string, unknown>)
    .filter((c) => chatIndividualValido(c.wa_chatid))
    .map((c) => ({
      chatid: String(c.wa_chatid).trim(),
      ultimaMs: paraMs(c.wa_lastMsgTimestamp),
    }));
}
