import { createHeadlessEditor } from "@lexical/headless";
import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import { describe, expect, it } from "vitest";
import { unescapeWhatsappMarkdown, WHATSAPP_TRANSFORMERS } from "./whatsapp-markdown-transformers";

function roundTrip(markdown: string): string {
  const editor = createHeadlessEditor({
    onError: (error) => {
      throw error;
    },
  });

  editor.update(
    () => {
      $convertFromMarkdownString(markdown, WHATSAPP_TRANSFORMERS);
    },
    { discrete: true },
  );

  let result = "";
  editor.getEditorState().read(() => {
    result = unescapeWhatsappMarkdown($convertToMarkdownString(WHATSAPP_TRANSFORMERS));
  });
  return result;
}

describe("WHATSAPP_TRANSFORMERS", () => {
  it("mantém texto plano sem marcadores intacto", () => {
    expect(roundTrip("mensagem sem formatação nenhuma")).toBe("mensagem sem formatação nenhuma");
  });

  it("faz round-trip de *negrito*", () => {
    expect(roundTrip("oi *tudo bem*?")).toBe("oi *tudo bem*?");
  });

  it("faz round-trip de _itálico_", () => {
    expect(roundTrip("_urgente_")).toBe("_urgente_");
  });

  it("faz round-trip de ~tachado~", () => {
    expect(roundTrip("~cancelado~")).toBe("~cancelado~");
  });

  it("faz round-trip de monoespaçado com crase tripla", () => {
    expect(roundTrip("```codigo aqui```")).toBe("```codigo aqui```");
  });

  it("faz round-trip de uma frase combinando os 4 marcadores", () => {
    const input = "oi *bold* e _italico_ e ~tachado~ e ```mono``` tudo junto";
    expect(roundTrip(input)).toBe(input);
  });

  it("não formata (e não escapa de volta) marcador colado a espaço", () => {
    expect(roundTrip("* não bold *")).toBe("* não bold *");
  });

  it("não injeta barra invertida em preço com asterisco solto", () => {
    expect(roundTrip("preço: R$ 10 * 2 = R$ 20")).toBe("preço: R$ 10 * 2 = R$ 20");
  });

  it("não injeta barra invertida em texto com underscore solto", () => {
    expect(roundTrip("acesse nome_sobrenome@empresa.com")).toBe("acesse nome_sobrenome@empresa.com");
  });
});

describe("unescapeWhatsappMarkdown", () => {
  it("remove barra invertida de escape dos 4 caracteres marcadores e da própria barra", () => {
    expect(unescapeWhatsappMarkdown("preço: R\\$ 10 \\* 2")).toBe("preço: R\\$ 10 * 2");
    expect(unescapeWhatsappMarkdown("a\\_b")).toBe("a_b");
    expect(unescapeWhatsappMarkdown("a\\~b")).toBe("a~b");
    expect(unescapeWhatsappMarkdown("a\\`b")).toBe("a`b");
    expect(unescapeWhatsappMarkdown("a\\\\b")).toBe("a\\b");
  });

  it("não mexe em texto sem barra invertida", () => {
    expect(unescapeWhatsappMarkdown("texto normal")).toBe("texto normal");
  });
});
