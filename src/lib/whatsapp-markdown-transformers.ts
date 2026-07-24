import { $isTextNode } from "lexical";
import {
  INLINE_CODE,
  type TextFormatTransformer,
  type TextMatchTransformer,
  type Transformer,
} from "@lexical/markdown";

const BOLD: TextFormatTransformer = {
  format: ["bold"],
  tag: "*",
  type: "text-format",
};

const ITALIC: TextFormatTransformer = {
  format: ["italic"],
  tag: "_",
  type: "text-format",
};

const STRIKETHROUGH: TextFormatTransformer = {
  format: ["strikethrough"],
  tag: "~",
  type: "text-format",
};

/**
 * `@lexical/markdown` exporta qualquer nó com format 'code' usando cerca
 * CommonMark de crase simples, hardcoded (ver exportTextFormat em
 * MarkdownExport.ts) — ignora o campo `tag` do transformer. Este
 * text-match transformer intercepta a exportação de nós com format 'code'
 * antes desse caminho, pra sair com a cerca tripla que o WhatsApp espera.
 * `regExp` nunca casa de propósito: este transformer não participa da
 * digitação ao vivo, só da exportação — quem trata a digitação é o
 * INLINE_CODE embutido (tag simples de crase), incluído abaixo.
 */
const MONOSPACE_EXPORT: TextMatchTransformer = {
  dependencies: [],
  export: (node) => {
    if (!$isTextNode(node) || !node.hasFormat("code")) return null;
    return "```" + node.getTextContent() + "```";
  },
  regExp: /(?!)/,
  type: "text-match",
};

export const WHATSAPP_TRANSFORMERS: Transformer[] = [
  MONOSPACE_EXPORT,
  INLINE_CODE,
  BOLD,
  ITALIC,
  STRIKETHROUGH,
];

/**
 * `$convertToMarkdownString` escapa `*_~\`\\` com barra invertida em texto
 * plano não-formatado, pra um reimport não interpretar sem querer. O
 * WhatsApp não tem esse escape — sem desfazer isso, um preço como
 * "R$ 10 * 2" sairia com barra invertida de verdade pro cliente.
 */
export function unescapeWhatsappMarkdown(markdown: string): string {
  return markdown.replace(/\\([*_~`\\])/g, "$1");
}
