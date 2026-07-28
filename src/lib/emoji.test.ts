import { describe, expect, test } from "vitest";
import { adicionarRecente, buscarEmojis, CATEGORIAS_EMOJI } from "./emoji";

describe("CATEGORIAS_EMOJI", () => {
  test("nenhum emoji aparece duas vezes na MESMA categoria", () => {
    for (const cat of CATEGORIAS_EMOJI) {
      const chars = cat.emojis.map((e) => e.char);
      expect(new Set(chars).size, `categoria ${cat.id} tem repetido`).toBe(chars.length);
    }
  });

  test("todo emoji tem ao menos um termo de busca", () => {
    for (const cat of CATEGORIAS_EMOJI) {
      for (const item of cat.emojis) {
        expect(item.termos.length, `${item.char} em ${cat.id} sem termo`).toBeGreaterThan(0);
      }
    }
  });

  test("nenhum item tem caractere de substituição (lixo de encoding)", () => {
    for (const cat of CATEGORIAS_EMOJI) {
      for (const item of cat.emojis) {
        expect(item.char, `${cat.id} tem char corrompido`).not.toContain("�");
        expect(item.char.length, `${cat.id} tem char vazio`).toBeGreaterThan(0);
      }
    }
  });

  test("ids de categoria são únicos", () => {
    const ids = CATEGORIAS_EMOJI.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buscarEmojis", () => {
  test("termo vazio não devolve nada (a UI mostra as categorias)", () => {
    expect(buscarEmojis("")).toEqual([]);
    expect(buscarEmojis("   ")).toEqual([]);
  });

  test("acha por termo exato", () => {
    expect(buscarEmojis("fogo").map((e) => e.char)).toContain("🔥");
  });

  test("acha por prefixo", () => {
    expect(buscarEmojis("come").map((e) => e.char)).toContain("🎉");
  });

  test("ignora acento na busca", () => {
    const comAcento = buscarEmojis("coração").map((e) => e.char);
    const semAcento = buscarEmojis("coracao").map((e) => e.char);
    expect(comAcento).toContain("❤️");
    expect(comAcento).toEqual(semAcento);
  });

  test("ignora caixa", () => {
    expect(buscarEmojis("FOGO").map((e) => e.char)).toContain("🔥");
  });

  test("casa termo de várias palavras pela palavra interna", () => {
    // "aperto de mao" tem que ser achável por "mao", não só por "aperto".
    expect(buscarEmojis("mao").map((e) => e.char)).toContain("🤝");
  });

  test("é prefixo e não 'contém': 'sol' não traz 'consolar'", () => {
    const chars = buscarEmojis("sol").map((e) => e.char);
    expect(chars).toContain("☀️");
    expect(chars).not.toContain("🧠");
  });

  test("termo sem correspondência devolve vazio", () => {
    expect(buscarEmojis("xyzabc123")).toEqual([]);
  });

  test("não repete o mesmo emoji quando ele está em duas categorias", () => {
    // 🥳 aparece em Rostos e em Festa.
    const chars = buscarEmojis("festa").map((e) => e.char);
    expect(new Set(chars).size).toBe(chars.length);
  });

  test("respeita o limite", () => {
    expect(buscarEmojis("a", 5).length).toBeLessThanOrEqual(5);
  });

  test("busca útil para o trabalho: 'nota' acha a nota fiscal", () => {
    expect(buscarEmojis("nota").map((e) => e.char)).toContain("🧾");
  });
});

describe("adicionarRecente", () => {
  test("põe o emoji novo na frente", () => {
    expect(adicionarRecente(["🔥", "✅"], "👍")).toEqual(["👍", "🔥", "✅"]);
  });

  test("reusar um emoji o move para a frente em vez de duplicar", () => {
    expect(adicionarRecente(["🔥", "✅", "👍"], "✅")).toEqual(["✅", "🔥", "👍"]);
  });

  test("não mutila a lista original (imutável)", () => {
    const original = ["🔥", "✅"];
    adicionarRecente(original, "👍");
    expect(original).toEqual(["🔥", "✅"]);
  });

  test("corta em 24 para o painel de recentes não crescer sem fim", () => {
    const muitos = Array.from({ length: 30 }, (_, i) => `e${i}`);
    const r = adicionarRecente(muitos, "novo");
    expect(r).toHaveLength(24);
    expect(r[0]).toBe("novo");
  });

  test("lista vazia vira lista de um", () => {
    expect(adicionarRecente([], "👍")).toEqual(["👍"]);
  });
});
