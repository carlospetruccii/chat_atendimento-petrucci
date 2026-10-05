import { normalizarE164 } from "@/lib/phone";

export interface ContatoVcard {
  nome: string | null;
  /** E.164, sem repetição, na ordem em que aparecem no cartão. */
  telefones: string[];
}

function desescapar(valor: string): string {
  return valor
    .replace(/\\([,;\\])/g, "$1")
    .replace(/\\n/gi, " ")
    .trim();
}

// `waid=` é o número do WhatsApp como o próprio WhatsApp enxerga (sem máscara e
// já no formato certo com/sem nono dígito); o texto depois do ":" é só a
// exibição. Sem waid, o jeito é normalizar o texto.
function telefoneDaLinha(params: string, valor: string): string | null {
  const waid = /(?:^|;)waid=(\d{8,15})/i.exec(params)?.[1];
  if (waid) return normalizarE164(`+${waid}`);
  return normalizarE164(valor);
}

/**
 * Lê nome e telefones do vCard que chega numa mensagem do tipo "contato".
 * `nomeFallback` é o displayName guardado em `content`, usado quando o cartão
 * não traz FN.
 */
export function lerVcard(
  vcard: string | null | undefined,
  nomeFallback: string | null,
): ContatoVcard {
  const fallback = nomeFallback?.trim() || null;
  if (!vcard) return { nome: fallback, telefones: [] };

  let nome: string | null = null;
  const telefones: string[] = [];

  for (const linha of vcard.split(/\r?\n/)) {
    const separador = linha.indexOf(":");
    if (separador < 0) continue;
    // "item1.TEL;waid=…" (iPhone) → chave "TEL", params "waid=…".
    const [chave, ...resto] = linha
      .slice(0, separador)
      .replace(/^item\d+\./i, "")
      .split(";");
    const valor = linha.slice(separador + 1);

    if (chave.toUpperCase() === "FN" && !nome) {
      nome = desescapar(valor) || null;
    } else if (chave.toUpperCase() === "TEL") {
      const tel = telefoneDaLinha(resto.join(";"), valor);
      if (tel && !telefones.includes(tel)) telefones.push(tel);
    }
  }

  return { nome: nome ?? fallback, telefones };
}
