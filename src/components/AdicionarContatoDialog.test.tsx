// @vitest-environment happy-dom

import { act, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AdicionarContatoDialog } from "./AdicionarContatoDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  cadastrarClienteSingle: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/clientes-queries", () => ({
  cadastrarClienteSingle: mocks.cadastrarClienteSingle,
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

describe("AdicionarContatoDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.cadastrarClienteSingle.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function renderDialog(props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    returnFocusRef?: RefObject<HTMLElement | null>;
  }) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AdicionarContatoDialog {...props} />
        </QueryClientProvider>,
      );
    });
  }

  function preencher(input: HTMLInputElement, value: string) {
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function enviarFormulario() {
    const form = document.querySelector("form");
    if (!(form instanceof HTMLFormElement)) throw new Error("Formulário não renderizado");

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
  }

  test("mostra erros ligados aos campos sem chamar o backend", async () => {
    renderDialog({ open: true, onOpenChange: vi.fn() });

    await enviarFormulario();

    expect(document.querySelector("#adicionar-contato-nome-error")?.textContent).toBe(
      "Informe um nome com pelo menos 2 caracteres.",
    );
    expect(document.querySelector("#adicionar-contato-telefone-error")?.textContent).toBe(
      "Informe um WhatsApp com DDD e número.",
    );
    expect(mocks.cadastrarClienteSingle).not.toHaveBeenCalled();
  });

  test("salva, invalida a busca e fecha o diálogo", async () => {
    const onOpenChange = vi.fn();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined);
    mocks.cadastrarClienteSingle.mockResolvedValue({
      ok: true,
      criado: true,
      atualizado: false,
      cliente: {
        id: "cliente-1",
        nome: "Maria",
        numero_whatsapp: "+5511999999999",
      },
      nome_anterior: null,
    });
    renderDialog({ open: true, onOpenChange });

    const nome = document.querySelector("#adicionar-contato-nome");
    const telefone = document.querySelector("#adicionar-contato-telefone");
    if (!(nome instanceof HTMLInputElement) || !(telefone instanceof HTMLInputElement)) {
      throw new Error("Campos não renderizados");
    }
    preencher(nome, "Maria");
    preencher(telefone, "(11) 99999-9999");
    await enviarFormulario();

    expect(mocks.cadastrarClienteSingle).toHaveBeenCalledWith("Maria", "+5511999999999");
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["clientes-autocomplete"] });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Contato adicionado");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("devolve o foco ao destino persistente quando fecha", async () => {
    const returnButton = document.createElement("button");
    document.body.appendChild(returnButton);
    const returnFocusRef = { current: returnButton };
    renderDialog({ open: true, onOpenChange: vi.fn(), returnFocusRef });

    await act(async () => {
      renderDialog({ open: false, onOpenChange: vi.fn(), returnFocusRef });
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(document.activeElement).toBe(returnButton));
    returnButton.remove();
  });
});
