// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MediaContato } from "./MediaContato";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({ iniciar: vi.fn() }));

vi.mock("@/hooks/useIniciarConversa", () => ({
  useIniciarConversa: () => mocks.iniciar,
}));

vi.mock("@/lib/clientes-queries", () => ({ cadastrarClienteSingle: vi.fn() }));

const VCARD =
  "BEGIN:VCARD\nVERSION:3.0\nFN:Contador Mario\nTEL;type=CELL;waid=559184008486:+55 91 8400-8486\nEND:VCARD";

function botao(texto: string): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll("button")).find((el) =>
    el.textContent?.includes(texto),
  );
  if (!b) throw new Error(`botão "${texto}" não encontrado`);
  return b as HTMLButtonElement;
}

describe("MediaContato", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.iniciar.mockReset();
    mocks.iniciar.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function render(vcard: string | null, nome: string | null, onLinha = vi.fn()) {
    const qc = new QueryClient();
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <div onClick={onLinha}>
            <MediaContato vcard={vcard} nomeExibicao={nome} />
          </div>
        </QueryClientProvider>,
      );
    });
    return onLinha;
  }

  test("mostra nome e número do cartão", () => {
    render(VCARD, "Contador Mario");

    expect(container.textContent).toContain("Contador Mario");
    expect(container.textContent).toContain("+55 (91) 8400-8486");
  });

  test("Conversar inicia com o número do cartão sem renomear cliente existente", async () => {
    const onLinha = render(VCARD, "Contador Mario");

    await act(async () => botao("Conversar").click());

    expect(mocks.iniciar).toHaveBeenCalledWith({
      nome: "Contador Mario",
      numero: "+559184008486",
      manterNomeExistente: true,
    });
    expect(onLinha).not.toHaveBeenCalled();
  });

  test("Salvar contato abre o diálogo já preenchido", async () => {
    render(VCARD, "Contador Mario");

    await act(async () => botao("Salvar contato").click());

    const nome = document.querySelector<HTMLInputElement>("#adicionar-contato-nome");
    const tel = document.querySelector<HTMLInputElement>("#adicionar-contato-telefone");
    expect(nome?.value).toBe("Contador Mario");
    expect(tel?.value).toBe("+559184008486");
  });

  test("cartão sem número desabilita as ações", () => {
    render(null, "Fulano");

    expect(container.textContent).toContain("Sem número de WhatsApp");
    expect(botao("Conversar").disabled).toBe(true);
    expect(botao("Salvar contato").disabled).toBe(true);
  });
});
