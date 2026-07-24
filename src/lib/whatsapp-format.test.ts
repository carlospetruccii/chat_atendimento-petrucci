import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { formatWhatsAppText } from "./whatsapp-format";

function renderedText(nodes: ReturnType<typeof formatWhatsAppText>): string {
  // Achata os ReactNode[] pra comparar só o texto visível, ignorando tags.
  return nodes
    .map((node) => {
      if (typeof node === "string") return node;
      if (node && typeof node === "object" && "props" in node) {
        const children = (node as { props: { children?: unknown } }).props.children;
        return typeof children === "string" ? children : "";
      }
      return "";
    })
    .join("");
}

describe("formatWhatsAppText", () => {
  it("retorna array vazio para texto nulo, indefinido ou vazio", () => {
    expect(formatWhatsAppText(null)).toEqual([]);
    expect(formatWhatsAppText(undefined)).toEqual([]);
    expect(formatWhatsAppText("")).toEqual([]);
  });

  it("mantém texto plano sem marcadores intacto", () => {
    const result = formatWhatsAppText("mensagem sem formatação nenhuma");
    expect(result).toEqual(["mensagem sem formatação nenhuma"]);
  });

  it("renderiza *negrito* como <strong>", () => {
    const result = formatWhatsAppText("oi *tudo bem*?");
    expect(result[0]).toBe("oi ");
    const strong = result[1] as ReactElement;
    expect(strong.type).toBe("strong");
    expect(strong.props.children).toBe("tudo bem");
    expect(result[2]).toBe("?");
  });

  it("renderiza _itálico_ como <em>", () => {
    const result = formatWhatsAppText("_urgente_");
    const em = result[0] as ReactElement;
    expect(em.type).toBe("em");
    expect(em.props.children).toBe("urgente");
  });

  it("renderiza ~tachado~ como <s>", () => {
    const result = formatWhatsAppText("~cancelado~");
    const s = result[0] as ReactElement;
    expect(s.type).toBe("s");
    expect(s.props.children).toBe("cancelado");
  });

  it("renderiza ```monoespaçado``` como <code>", () => {
    const result = formatWhatsAppText("```codigo_com_underscore```");
    const code = result[0] as ReactElement;
    expect(code.type).toBe("code");
    expect(code.props.children).toBe("codigo_com_underscore");
  });

  it("não formata quando há espaço colado ao marcador", () => {
    const result = formatWhatsAppText("* não bold *");
    expect(result).toEqual(["* não bold *"]);
  });

  it("marcador sem par de fechamento fica literal", () => {
    const result = formatWhatsAppText("preço: R$ 10 * 2 = R$ 20");
    expect(result).toEqual(["preço: R$ 10 * 2 = R$ 20"]);
  });

  it("combina múltiplos marcadores na mesma mensagem", () => {
    const result = formatWhatsAppText("oi *bold* e _italico_ e ~tachado~ tudo junto");
    expect(renderedText(result)).toBe("oi bold e italico e tachado tudo junto");
    expect((result[1] as ReactElement).type).toBe("strong");
    expect((result[3] as ReactElement).type).toBe("em");
    expect((result[5] as ReactElement).type).toBe("s");
  });

  it("linkifica URL e preserva formatação junto", () => {
    const result = formatWhatsAppText("olha isso: https://exemplo.com/pagina, *importante*");
    const link = result.find(
      (node) => typeof node === "object" && node !== null && (node as ReactElement).type === "a",
    ) as ReactElement;
    expect(link.props.href).toBe("https://exemplo.com/pagina");
  });

  it("remove pontuação final da URL mas mantém formatação depois", () => {
    const result = formatWhatsAppText("veja https://exemplo.com.");
    const link = result.find(
      (node) => typeof node === "object" && node !== null && (node as ReactElement).type === "a",
    ) as ReactElement;
    expect(link.props.href).toBe("https://exemplo.com");
    expect(result[result.length - 1]).toBe(".");
  });
});
