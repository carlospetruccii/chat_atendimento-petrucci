import { beforeEach, describe, expect, test, vi } from "vitest";

const download = vi.fn();
const from = vi.fn((_bucket: string) => ({ download }));
const invoke = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: { from: (bucket: string) => from(bucket) },
    functions: { invoke: (...args: unknown[]) => invoke(...args) },
  },
}));

import { ErroIaTexto, transcreverAudioArmazenado } from "@/lib/ai-texto";

describe("transcreverAudioArmazenado", () => {
  beforeEach(() => {
    download.mockReset();
    from.mockClear();
    invoke.mockReset();
  });

  test("baixa o áudio do bucket e manda para a ai-texto com o mime do arquivo", async () => {
    // Arrange
    download.mockResolvedValue({
      data: new Blob(["x".repeat(300)], { type: "audio/mpeg" }),
      error: null,
    });
    invoke.mockResolvedValue({ data: { ok: true, texto: "Oi, tudo bem?" }, error: null });

    // Act
    const texto = await transcreverAudioArmazenado("cliente/abc.mp3");

    // Assert
    expect(texto).toBe("Oi, tudo bem?");
    expect(from).toHaveBeenCalledWith("mensagens-midia");
    expect(download).toHaveBeenCalledWith("cliente/abc.mp3");
    const [nome, opcoes] = invoke.mock.calls[0] as [string, { body: FormData }];
    expect(nome).toBe("ai-texto");
    const file = opcoes.body.get("file") as File;
    expect(file.type).toBe("audio/mpeg");
  });

  test("usa audio/ogg quando o storage devolve blob sem mime de áudio", async () => {
    download.mockResolvedValue({
      data: new Blob(["x"], { type: "application/octet-stream" }),
      error: null,
    });
    invoke.mockResolvedValue({ data: { ok: true, texto: "ok" }, error: null });

    await transcreverAudioArmazenado("a/b.ogg");

    const [, opcoes] = invoke.mock.calls[0] as [string, { body: FormData }];
    expect((opcoes.body.get("file") as File).type).toBe("audio/ogg");
  });

  test("falha com mensagem amigável quando o download dá erro", async () => {
    download.mockResolvedValue({ data: null, error: new Error("not found") });

    await expect(transcreverAudioArmazenado("x")).rejects.toThrow(
      "Não foi possível baixar o áudio.",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  test("repassa o erro de negócio da ai-texto", async () => {
    download.mockResolvedValue({ data: new Blob(["x"], { type: "audio/webm" }), error: null });
    invoke.mockResolvedValue({
      data: { ok: false, erro: "Áudio vazio ou inválido." },
      error: null,
    });

    const erro = await transcreverAudioArmazenado("x").catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroIaTexto);
    expect((erro as Error).message).toBe("Áudio vazio ou inválido.");
  });
});
