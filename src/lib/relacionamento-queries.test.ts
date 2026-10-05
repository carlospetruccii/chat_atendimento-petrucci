import { beforeEach, describe, expect, test, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

import { fetchRelacionamento } from "./relacionamento-queries";

const range = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-17T23:59:59.999Z" };

describe("fetchRelacionamento", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: null, error: null });
  });

  test("sem filtro manda os 4 parâmetros com null — nunca omite", async () => {
    await fetchRelacionamento(range);

    expect(rpc).toHaveBeenCalledWith("dashboard_relacionamento", {
      p_from: range.from,
      p_to: range.to,
      p_department_id: null,
      p_user_id: null,
    });
  });

  test("repassa departamento e pessoa escolhidos", async () => {
    await fetchRelacionamento(range, { departmentId: "d1", userId: "u1" });

    expect(rpc).toHaveBeenCalledWith(
      "dashboard_relacionamento",
      expect.objectContaining({ p_department_id: "d1", p_user_id: "u1" }),
    );
  });

  test("erro do RPC é propagado", async () => {
    const erro = new Error("boom");
    rpc.mockResolvedValue({ data: null, error: erro });

    await expect(fetchRelacionamento(range)).rejects.toBe(erro);
  });
});
