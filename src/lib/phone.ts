// Utilitários de telefone/WhatsApp compartilhados pela UI.
// E.164 = "+" seguido de 8 a 15 dígitos (o "+" e o DDI juntos).

/**
 * Normaliza um número digitado para E.164 (+55...). Aceita com/sem máscara.
 * Sem código de país, assume Brasil (55) para 10–11 dígitos (DDD + número).
 * Retorna null se não formar um E.164 válido (mesma regra da CHECK do banco).
 */
export function normalizarE164(input: string): string | null {
  const trimmed = (input ?? "").trim();
  // Idempotente: se já é E.164 válido, devolve como está (não re-prefixa DDI).
  // Sem isso, reprocessar um número não-BR de 11 dígitos (ex.: +1 US) o corromperia.
  if (/^\+[1-9][0-9]{7,14}$/.test(trimmed)) return trimmed;
  let d = trimmed.replace(/\D/g, "");
  d = d.replace(/^0+/, "");
  if (!d) return null;
  if (d.length === 10 || d.length === 11) d = "55" + d;
  const e164 = "+" + d;
  return /^\+[1-9][0-9]{7,14}$/.test(e164) ? e164 : null;
}

/** Formata E.164 para exibição: +55 (11) 91234-5678 quando for número BR. */
export function formatarNumero(e164: string): string {
  const br = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
  if (br) return `+55 (${br[1]}) ${br[2]}-${br[3]}`;
  return e164;
}
