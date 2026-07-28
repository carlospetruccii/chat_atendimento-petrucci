import { describe, expect, test } from "vitest";
import {
  agruparMensagensInternas,
  dedupeAndSortInternas,
  iniciaisDoNome,
} from "./internas-history";
import type { MensagemInterna } from "./internas-queries";

const SILMARA = "a107c7ce-0000-0000-0000-000000000001";
const ANDREZA = "2147272d-0000-0000-0000-000000000002";

function msg(over: Partial<MensagemInterna> & { id: string; createdAt: string }): MensagemInterna {
  return {
    conversaId: "c1",
    senderUserId: SILMARA,
    senderNome: "Silmara",
    content: "oi",
    ...over,
  };
}

describe("agruparMensagensInternas", () => {
  test("retorna vazio quando não há mensagens", () => {
    expect(agruparMensagensInternas([], SILMARA)).toEqual([]);
  });

  test("abre um separador de dia antes da primeira mensagem", () => {
    const items = agruparMensagensInternas(
      [msg({ id: "m1", createdAt: "2026-07-28T12:00:00Z" })],
      SILMARA,
    );

    expect(items[0].kind).toBe("date-separator");
    expect(items).toHaveLength(2);
  });

  test("cria um separador por dia, não por mensagem", () => {
    const items = agruparMensagensInternas(
      [
        msg({ id: "m1", createdAt: "2026-07-27T12:00:00Z" }),
        msg({ id: "m2", createdAt: "2026-07-27T13:00:00Z" }),
        msg({ id: "m3", createdAt: "2026-07-28T09:00:00Z" }),
      ],
      SILMARA,
    );

    expect(items.filter((i) => i.kind === "date-separator")).toHaveLength(2);
    expect(items.filter((i) => i.kind === "message")).toHaveLength(3);
  });

  test("marca 'minha' apenas nas mensagens de quem está olhando", () => {
    const items = agruparMensagensInternas(
      [
        msg({ id: "m1", createdAt: "2026-07-28T12:00:00Z", senderUserId: SILMARA }),
        msg({ id: "m2", createdAt: "2026-07-28T12:01:00Z", senderUserId: ANDREZA }),
      ],
      SILMARA,
    );

    const mensagens = items.filter((i) => i.kind === "message");
    expect(mensagens.map((m) => m.kind === "message" && m.minha)).toEqual([true, false]);
  });

  test("a MESMA conversa vista pela outra pessoa inverte os lados", () => {
    const mensagens = [
      msg({ id: "m1", createdAt: "2026-07-28T12:00:00Z", senderUserId: SILMARA }),
      msg({ id: "m2", createdAt: "2026-07-28T12:01:00Z", senderUserId: ANDREZA }),
    ];

    const vistoPelaAndreza = agruparMensagensInternas(mensagens, ANDREZA)
      .filter((i) => i.kind === "message")
      .map((m) => m.kind === "message" && m.minha);

    expect(vistoPelaAndreza).toEqual([false, true]);
  });

  test("cola mensagens seguidas do mesmo autor e descola quando o autor troca", () => {
    const items = agruparMensagensInternas(
      [
        msg({ id: "m1", createdAt: "2026-07-28T12:00:00Z", senderUserId: SILMARA }),
        msg({ id: "m2", createdAt: "2026-07-28T12:01:00Z", senderUserId: SILMARA }),
        msg({ id: "m3", createdAt: "2026-07-28T12:02:00Z", senderUserId: ANDREZA }),
      ],
      SILMARA,
    );

    const coladas = items
      .filter((i) => i.kind === "message")
      .map((m) => m.kind === "message" && m.colada);
    expect(coladas).toEqual([false, true, false]);
  });

  test("separador de dia reinicia o bloco de autor", () => {
    const items = agruparMensagensInternas(
      [
        msg({ id: "m1", createdAt: "2026-07-27T23:00:00Z", senderUserId: SILMARA }),
        msg({ id: "m2", createdAt: "2026-07-28T09:00:00Z", senderUserId: SILMARA }),
      ],
      SILMARA,
    );

    // Mesmo autor, mas dia novo: a segunda NÃO vem colada.
    const ultima = items[items.length - 1];
    expect(ultima.kind === "message" && ultima.colada).toBe(false);
  });
});

describe("dedupeAndSortInternas", () => {
  test("devolve a lista original quando não chega nada", () => {
    const prev = [msg({ id: "m1", createdAt: "2026-07-28T12:00:00Z" })];
    expect(dedupeAndSortInternas(prev, [])).toBe(prev);
  });

  test("não duplica mensagem que já está na lista", () => {
    const m = msg({ id: "m1", createdAt: "2026-07-28T12:00:00Z" });
    expect(dedupeAndSortInternas([m], [m])).toHaveLength(1);
  });

  test("a versão que chega depois substitui a anterior de mesmo id", () => {
    const antiga = msg({ id: "m1", createdAt: "2026-07-28T12:00:00Z", content: "rascunho" });
    const nova = msg({ id: "m1", createdAt: "2026-07-28T12:00:00Z", content: "final" });
    expect(dedupeAndSortInternas([antiga], [nova])[0].content).toBe("final");
  });

  test("ordena ascendente por createdAt", () => {
    const ordenadas = dedupeAndSortInternas(
      [msg({ id: "m2", createdAt: "2026-07-28T12:05:00Z" })],
      [msg({ id: "m1", createdAt: "2026-07-28T12:00:00Z" })],
    );
    expect(ordenadas.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  test("desempata por id quando o createdAt é idêntico", () => {
    const mesmoInstante = "2026-07-28T12:00:00Z";
    const ordenadas = dedupeAndSortInternas(
      [msg({ id: "bbb", createdAt: mesmoInstante })],
      [msg({ id: "aaa", createdAt: mesmoInstante })],
    );
    expect(ordenadas.map((m) => m.id)).toEqual(["aaa", "bbb"]);
  });
});

describe("iniciaisDoNome", () => {
  test("usa as duas primeiras palavras", () => {
    expect(iniciaisDoNome("Larissa Bianca Mrozkco")).toBe("LB");
  });

  test("funciona com nome único", () => {
    expect(iniciaisDoNome("Silmara")).toBe("S");
  });

  test("ignora espaços extras", () => {
    expect(iniciaisDoNome("  Leticia   Vitória  ")).toBe("LV");
  });
});
