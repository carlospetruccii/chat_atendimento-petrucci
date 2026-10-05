import { describe, expect, test } from "vitest";
import { chatLoadState } from "./inbox-history";

describe("chatLoadState", () => {
  test("erro de carregamento tem prioridade sobre o estado de conversa vazia", () => {
    expect(
      chatLoadState({
        isLoadingInitial: false,
        error: new Error("timeout"),
        itemCount: 0,
      }),
    ).toBe("error");
  });

  test("erro PostgREST em formato de objeto também não vira conversa vazia", () => {
    expect(
      chatLoadState({
        isLoadingInitial: false,
        error: { code: "57014", message: "statement timeout" },
        itemCount: 0,
      }),
    ).toBe("error");
  });

  test("falha inicial continua visível mesmo se uma mensagem realtime chegar", () => {
    expect(
      chatLoadState({
        isLoadingInitial: false,
        error: new Error("falha na carga inicial"),
        itemCount: 1,
      }),
    ).toBe("error");
  });
});
