import { beforeEach, describe, expect, test, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } },
}));

import { reprocessarMidia } from "./midia-acoes";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ data: { ok: true }, error: null });
});

describe("reprocessarMidia", () => {
  test("sem escopo continua indo para reprocessar-midia como individual", async () => {
    expect(await reprocessarMidia({ mensagemId: "m1" })).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("reprocessar-midia", {
      body: { mensagem_id: "m1", escopo: "individual" },
    });
  });

  test("grupo mantém o escopo na reprocessar-midia", async () => {
    await reprocessarMidia({ mensagemId: "m1", escopo: "grupo" });
    expect(invoke).toHaveBeenCalledWith("reprocessar-midia", {
      body: { mensagem_id: "m1", escopo: "grupo" },
    });
  });

  test("recusa vira frase; motivo desconhecido cai no genérico", async () => {
    invoke.mockResolvedValue({ data: { ok: false, motivo: "tentativa_recente" }, error: null });
    expect((await reprocessarMidia({ mensagemId: "m1" })).motivo).toMatch(
      /tentativa em andamento/,
    );
    invoke.mockResolvedValue({ data: { ok: false, motivo: "xyz" }, error: null });
    expect((await reprocessarMidia({ mensagemId: "m1" })).motivo).toBe(
      "Não foi possível tentar de novo agora.",
    );
  });

  test("erro de transporte é propagado", async () => {
    const erro = new Error("offline");
    invoke.mockResolvedValue({ data: null, error: erro });
    await expect(reprocessarMidia({ mensagemId: "m1" })).rejects.toBe(erro);
  });
});
