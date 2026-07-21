import type { ReactNode } from "react";

const URL_REGEX = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCTUATION_REGEX = /[.,;:!?)\]}'"]+$/;

function stripTrailingPunctuation(url: string): { url: string; trailing: string } {
  const match = url.match(TRAILING_PUNCTUATION_REGEX);
  if (!match) return { url, trailing: "" };
  return { url: url.slice(0, -match[0].length), trailing: match[0] };
}

/** Renders text with http(s) URLs turned into clickable links, safe from XSS (no dangerouslySetInnerHTML, no non-http schemes). */
export function linkifyText(text: string | null | undefined): ReactNode[] {
  if (!text) return [];

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    const { url, trailing } = stripTrailingPunctuation(match[0]);
    if (!url) continue;

    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    parts.push(
      <a
        key={key++}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 break-all hover:opacity-80"
        onClick={(e) => e.stopPropagation()}
      >
        {url}
      </a>,
    );

    if (trailing) parts.push(trailing);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}
