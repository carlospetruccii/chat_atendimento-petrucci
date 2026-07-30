// Decisões puras do backfill (sem banco e sem rede), para poder testar.

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Ids pelos quais esta mensagem pode já estar gravada.
 *
 * O webhook grava o formato composto `owner:messageid` (conferido em produção),
 * mas o `/message/find` devolve `id`, `messageid` e `owner` separados e a doc da
 * uazapi é ambígua sobre o que vem em `id`. Conferimos contra TODAS as formas —
 * errar aqui significaria gravar de novo uma mensagem que já está na conversa.
 */
export function idsPossiveis(m: Record<string, unknown>): { preferido: string | null; todos: string[] } {
  const owner = texto(m.owner);
  const messageid = texto(m.messageid);
  const id = texto(m.id);
  const composto = owner && messageid ? `${owner}:${messageid}` : "";
  const preferido = composto || (id.includes(":") ? id : "") || id || messageid || "";
  const todos = [...new Set([composto, id, messageid].filter((v) => v !== ""))];
  return { preferido: preferido || null, todos };
}

export function inteiroNoIntervalo(v: unknown, padrao: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
