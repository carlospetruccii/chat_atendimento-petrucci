import { describe, expect, test, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { taxaEncerrados, todasAsLinhas } from "./dashboard-queries";

describe("taxaEncerrados", () => {
  test("percentual inteiro dos atendimentos do período que já fecharam", () => {
    expect(taxaEncerrados(16, 23)).toBe("70%");
  });

  test("sem atendimento no período mostra travessão, não 0%", () => {
    expect(taxaEncerrados(0, 0)).toBe("—");
  });

  test("todos encerrados dá 100%", () => {
    expect(taxaEncerrados(5, 5)).toBe("100%");
  });

  test("nunca passa de 100%, mesmo com contagem inconsistente", () => {
    expect(taxaEncerrados(7, 5)).toBe("100%");
  });
});

describe("todasAsLinhas", () => {
  /** Query falsa que devolve `total` linhas respeitando o teto de 1000 do PostgREST. */
  function queryFalsa(total: number, chamadas: number[]) {
    return () => ({
      range: (de: number, ate: number) => {
        chamadas.push(de);
        const fim = Math.min(ate + 1, total, de + 1000);
        return Promise.resolve({
          data: Array.from({ length: Math.max(fim - de, 0) }, (_, i) => ({ id: de + i })),
          error: null,
        });
      },
    });
  }

  test("uma página só quando vem menos que o teto", async () => {
    const chamadas: number[] = [];
    const linhas = await todasAsLinhas<{ id: number }>(queryFalsa(367, chamadas));

    expect(linhas).toHaveLength(367);
    expect(chamadas).toEqual([0]);
  });

  test("continua paginando além das 1000 linhas do PostgREST", async () => {
    const chamadas: number[] = [];
    const linhas = await todasAsLinhas<{ id: number }>(queryFalsa(2500, chamadas));

    expect(linhas).toHaveLength(2500);
    expect(chamadas).toEqual([0, 1000, 2000]);
  });

  test("total exatamente múltiplo do teto faz uma página extra vazia e para", async () => {
    const chamadas: number[] = [];
    const linhas = await todasAsLinhas<{ id: number }>(queryFalsa(1000, chamadas));

    expect(linhas).toHaveLength(1000);
    expect(chamadas).toEqual([0, 1000]);
  });

  test("erro da query é propagado", async () => {
    const erro = new Error("boom");
    await expect(
      todasAsLinhas(() => ({ range: () => Promise.resolve({ data: null, error: erro }) })),
    ).rejects.toBe(erro);
  });
});
