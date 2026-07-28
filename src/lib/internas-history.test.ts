import { describe, expect, test } from "vitest";
import {
  agruparMensagensInternas,
  dedupeAndSortInternas,
  iniciaisDoNome,
  previewDaConversa,
} from "./internas-history";
import type { MensagemInterna } from "./internas-queries";

const SILMARA = "a107c7ce-0000-0000-0000-000000000001";
const ANDREZA = "2147272d-0000-0000-0000-000000000002";

function msg(over: Partial<MensagemInterna> & { id: string; createdAt: string }): MensagemInterna {
  return {
    conversaId: "c1",
    senderUserId: SILMARA,
    senderNome: "Silmara",
    tipo: "texto",
    content: "oi",
    mediaUrl: null,
    mediaMetadata: null,
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

describe("previewDaConversa", () => {
  test("usa o texto quando existe", () => {
    expect(previewDaConversa("bom dia", "texto", false)).toBe("bom dia");
  });

  test("prefixa 'Você:' quando a última mensagem é minha", () => {
    expect(previewDaConversa("bom dia", "texto", true)).toBe("Você: bom dia");
  });

  test("mídia SEM legenda cai no rótulo do tipo", () => {
    expect(previewDaConversa(null, "imagem", false)).toBe("📷 Imagem");
    expect(previewDaConversa(null, "audio", false)).toBe("🎤 Áudio");
    expect(previewDaConversa(null, "video", false)).toBe("🎥 Vídeo");
    expect(previewDaConversa(null, "documento", false)).toBe("📎 Documento");
  });

  test("mídia COM legenda mostra a legenda, não o rótulo", () => {
    expect(previewDaConversa("olha o balanço", "imagem", false)).toBe("olha o balanço");
  });

  test("rótulo de mídia também recebe o prefixo 'Você:'", () => {
    expect(previewDaConversa(null, "audio", true)).toBe("Você: 🎤 Áudio");
  });

  test("conversa sem nenhuma mensagem fica vazia", () => {
    expect(previewDaConversa(null, null, null)).toBe("");
  });

  test("tipo desconhecido não inventa rótulo", () => {
    expect(previewDaConversa(null, "sticker", false)).toBe("");
  });
});

describe("agruparMensagensInternas com mídia", () => {
  test("mídia entra na conversa como mensagem normal, do lado certo", () => {
    const items = agruparMensagensInternas(
      [
        msg({
          id: "m1",
          createdAt: "2026-07-28T12:00:00Z",
          tipo: "imagem",
          content: null,
          mediaMetadata: { storage_path: "internas/c1/foto.jpg" },
        }),
      ],
      SILMARA,
    );

    const mensagem = items.find((i) => i.kind === "message");
    expect(mensagem?.kind === "message" && mensagem.minha).toBe(true);
    expect(mensagem?.kind === "message" && mensagem.message.tipo).toBe("imagem");
  });

  test("texto e mídia do mesmo autor seguem colados", () => {
    const items = agruparMensagensInternas(
      [
        msg({ id: "m1", createdAt: "2026-07-28T12:00:00Z" }),
        msg({
          id: "m2",
          createdAt: "2026-07-28T12:01:00Z",
          tipo: "documento",
          content: null,
          mediaMetadata: { storage_path: "internas/c1/doc.pdf" },
        }),
      ],
      SILMARA,
    );

    const coladas = items
      .filter((i) => i.kind === "message")
      .map((m) => m.kind === "message" && m.colada);
    expect(coladas).toEqual([false, true]);
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
