import type { ReactNode } from "react";

// Ordem importa: monoespaçado primeiro (conteúdo não deve ser re-processado
// pelos outros marcadores), URL por último. `[^\s*]`/etc. no início e fim do
// grupo impedem que `* fica *` (espaço colado ao marcador) formate — mesma
// regra do WhatsApp real.
const TOKEN_REGEX =
  /```([^`]+)```|\*([^\s*](?:[^*]*[^\s*])?)\*|_([^\s_](?:[^_]*[^\s_])?)_|~([^\s~](?:[^~]*[^\s~])?)~|(https?:\/\/[^\s<>"']+)/g;
const TRAILING_PUNCTUATION_REGEX = /[.,;:!?)\]}'"]+$/;

function stripTrailingPunctuation(url: string): { url: string; trailing: string } {
  const match = url.match(TRAILING_PUNCTUATION_REGEX);
  if (!match) return { url, trailing: "" };
  return { url: url.slice(0, -match[0].length), trailing: match[0] };
}

/**
 * Renderiza texto com a formatação do WhatsApp (negrito/itálico/tachado/
 * monoespaçado) e URLs viráveis em link — sem dangerouslySetInnerHTML, sem
 * suporte a esquemas não-http. Marcador sem par de fechamento (ou com espaço
 * colado) fica literal, igual ao WhatsApp real.
 */
export function formatWhatsAppText(text: string | null | undefined): ReactNode[] {
  if (!text) return [];

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  TOKEN_REGEX.lastIndex = 0;
  while ((match = TOKEN_REGEX.exec(text)) !== null) {
    const [full, mono, bold, italic, strike, url] = match;

    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (mono !== undefined) {
      parts.push(
        <code key={key++} className="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.9em]">
          {mono}
        </code>,
      );
    } else if (bold !== undefined) {
      parts.push(<strong key={key++}>{bold}</strong>);
    } else if (italic !== undefined) {
      parts.push(<em key={key++}>{italic}</em>);
    } else if (strike !== undefined) {
      parts.push(<s key={key++}>{strike}</s>);
    } else if (url !== undefined) {
      const { url: cleanUrl, trailing } = stripTrailingPunctuation(url);
      if (cleanUrl) {
        parts.push(
          <a
            key={key++}
            href={cleanUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 break-all hover:opacity-80"
            onClick={(e) => e.stopPropagation()}
          >
            {cleanUrl}
          </a>,
        );
        if (trailing) parts.push(trailing);
      } else {
        parts.push(url);
      }
    }

    lastIndex = match.index + full.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}
