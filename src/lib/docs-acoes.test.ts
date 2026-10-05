import { beforeEach, describe, expect, test, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } },
}));

import {
  apagarDocsMensagens,
  editarDocsMensagem,
  encaminharDocsMensagem,
  marcarDocsLidoNoWhatsapp,
  notificarRepasseDocs,
  sendDocsAudio,
  sendDocsMedia,
  sendDocsTexto,
} from "./docs-acoes";

/** Erro do invoke com o corpo da resposta não-2xx em `context`. */
const erroHttp = (status: number, corpo: unknown) => ({
  data: null,
  error: Object.assign(new Error("non-2xx"), {
    context: new Response(JSON.stringify(corpo), { status }),
  }),
});

beforeEach(() => {
  invoke.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("envio (docs-enviar)", () => {
  test("texto manda conversa, conteúdo e citação; devolve o id gravado", async () => {
    invoke.mockResolvedValue({ data: { ok: true, mensagem_id: "m1" }, error: null });
    const id = await sendDocsTexto({ conversaId: "c1", content: "Oi", replyToMessageId: "r1" });
    expect(id).toBe("m1");
    expect(invoke).toHaveBeenCalledWith("docs-enviar", {
      body: { conversa_id: "c1", tipo: "texto", content: "Oi", reply_to_message_id: "r1" },
    });
  });

  test("mídia vai em base64 com mime, nome e legenda", async () => {
    invoke.mockResolvedValue({ data: { ok: true }, error: null });
    const file = new File(["oi"], "boleto.pdf", { type: "application/pdf" });
    const id = await sendDocsMedia({ conversaId: "c1", tipo: "document", file, caption: "  " });
    expect(id).toBeNull();
    const body = invoke.mock.calls[0][1].body;
    expect(body).toMatchObject({
      conversa_id: "c1",
      tipo: "document",
      arquivo_base64: "b2k=",
      mime_type: "application/pdf",
      nome_arquivo: "boleto.pdf",
    });
    expect(body.content).toBeUndefined();
  });

  test("áudio leva a duração", async () => {
    invoke.mockResolvedValue({ data: { ok: true, mensagem_id: "a1" }, error: null });
    await sendDocsAudio({
      conversaId: "c1",
      blob: new Blob(["x"]),
      mimeType: "audio/ogg",
      durationSeconds: 7,
    });
    expect(invoke.mock.calls[0][1].body).toMatchObject({ tipo: "audio", duracao_seg: 7 });
  });

  test("403 nao_e_dono vira frase explicando que só o dono responde", async () => {
    invoke.mockResolvedValue(erroHttp(403, { ok: false, erro: "nao_e_dono" }));
    await expect(sendDocsTexto({ conversaId: "c1", content: "x" })).rejects.toThrow(/dono/);
  });

  test("recusa em 200 também vira erro legível", async () => {
    invoke.mockResolvedValue({ data: { ok: false, erro: "arquivo_muito_grande" }, error: null });
    await expect(sendDocsTexto({ conversaId: "c1", content: "x" })).rejects.toThrow(/16 MB/);
  });
});

describe("apagarDocsMensagens", () => {
  test("lote vazio nem chama o servidor", async () => {
    expect(await apagarDocsMensagens([])).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  test("resultado parcial vem por mensagem, com motivo no vocabulário da Inbox", async () => {
    invoke.mockResolvedValue({
      data: {
        ok: false,
        resultados: [
          { mensagem_id: "a", ok: true },
          { mensagem_id: "b", ok: false, motivo: "nao_encontrada" },
          { mensagem_id: "c", ok: false, motivo: "sem_permissao" },
        ],
      },
      error: null,
    });
    const r = await apagarDocsMensagens(["a", "b", "c"]);
    expect(invoke).toHaveBeenCalledWith("docs-acao", {
      body: { acao: "apagar", mensagem_ids: ["a", "b", "c"] },
    });
    expect(r[0]).toEqual({ mensagemId: "a", ok: true, motivo: undefined, detalhe: undefined });
    expect(r[1].motivo).toBe("mensagem_nao_encontrada");
    expect(r[2].detalhe).toMatch(/dono/);
  });

  test("sem acesso ao Docs (403) lança", async () => {
    invoke.mockResolvedValue(erroHttp(403, { ok: false, erro: "forbidden" }));
    await expect(apagarDocsMensagens(["a"])).rejects.toThrow("Você não tem acesso ao Docs.");
  });

  test("resposta sem resultados lança", async () => {
    invoke.mockResolvedValue({ data: { ok: false }, error: null });
    await expect(apagarDocsMensagens(["a"])).rejects.toThrow(/apagar/);
  });
});

describe("editarDocsMensagem", () => {
  test("texto vazio nem sai daqui", async () => {
    expect(await editarDocsMensagem({ mensagemId: "m", texto: "  " })).toEqual({
      ok: false,
      detalhe: "O texto não pode ficar vazio.",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  test("sucesso devolve texto e horário da edição", async () => {
    invoke.mockResolvedValue({
      data: { ok: true, editada_em: "2026-09-29T10:00:00Z", conteudo: "novo" },
      error: null,
    });
    expect(await editarDocsMensagem({ mensagemId: "m", texto: " novo " })).toEqual({
      ok: true,
      editadaEm: "2026-09-29T10:00:00Z",
      conteudo: "novo",
    });
    expect(invoke.mock.calls[0][1].body).toEqual({
      acao: "editar",
      mensagem_id: "m",
      texto: "novo",
    });
  });

  test("recusa de prazo volta com o motivo", async () => {
    invoke.mockResolvedValue({ data: { ok: false, motivo: "fora_da_janela" }, error: null });
    expect(await editarDocsMensagem({ mensagemId: "m", texto: "x" })).toEqual({
      ok: false,
      motivo: "fora_da_janela",
      detalhe: undefined,
    });
  });

  test("500 com detalhe (editou no WhatsApp, não gravou aqui) mostra o detalhe", async () => {
    invoke.mockResolvedValue(
      erroHttp(500, { ok: false, motivo: "falha_whatsapp", detalhe: "Editada lá, não aqui." }),
    );
    const r = await editarDocsMensagem({ mensagemId: "m", texto: "x" });
    expect(r).toMatchObject({ ok: false, detalhe: "Editada lá, não aqui." });
  });
});

describe("encaminharDocsMensagem", () => {
  test("manda a conversa de destino e devolve o id novo", async () => {
    invoke.mockResolvedValue({ data: { ok: true, mensagem_id: "n1" }, error: null });
    expect(await encaminharDocsMensagem({ mensagemId: "m", destinoId: "c2" })).toEqual({
      ok: true,
      mensagemId: "n1",
    });
    expect(invoke.mock.calls[0][1].body).toEqual({
      acao: "encaminhar",
      mensagem_id: "m",
      conversa_id_destino: "c2",
    });
  });

  test("destino que não é meu explica o motivo", async () => {
    invoke.mockResolvedValue({ data: { ok: false, motivo: "nao_e_dono" }, error: null });
    const r = await encaminharDocsMensagem({ mensagemId: "m", destinoId: "c2" });
    expect(r.ok).toBe(false);
    expect(r.detalhe).toMatch(/dono/);
  });

  test("500 sem motivo lança com frase curta", async () => {
    invoke.mockResolvedValue(erroHttp(500, { ok: false, erro: "copia_midia_falhou" }));
    await expect(encaminharDocsMensagem({ mensagemId: "m", destinoId: "c2" })).rejects.toThrow(
      /copiar o arquivo/,
    );
  });

  test("códigos de pedido/servidor viram frase legível", async () => {
    invoke.mockResolvedValue(erroHttp(400, { ok: false, erro: "texto_muito_longo" }));
    await expect(editarDocsMensagem({ mensagemId: "m", texto: "x" })).rejects.toThrow(/4096/);
    invoke.mockResolvedValue(erroHttp(400, { ok: false, erro: "muitas_mensagens" }));
    await expect(apagarDocsMensagens(["a"])).rejects.toThrow(/10 mensagens/);
    invoke.mockResolvedValue(erroHttp(500, { ok: false, erro: "erro_interno" }));
    await expect(encaminharDocsMensagem({ mensagemId: "m", destinoId: "c2" })).rejects.toThrow(
      /servidor/,
    );
  });

  test("erro de rede sem corpo lança genérico", async () => {
    invoke.mockResolvedValue({ data: null, error: new Error("offline") });
    await expect(encaminharDocsMensagem({ mensagemId: "m", destinoId: "c2" })).rejects.toThrow(
      /Não foi possível concluir/,
    );
  });
});

describe("best-effort", () => {
  test("marcar lido no WhatsApp nunca lança", async () => {
    invoke.mockResolvedValue({ data: null, error: new Error("offline") });
    await expect(marcarDocsLidoNoWhatsapp("c1")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("docs-acao", {
      body: { acao: "marcar_lido", conversa_id: "c1" },
    });
  });

  test("aviso de repasse nunca lança", async () => {
    invoke.mockResolvedValue({ data: null, error: new Error("offline") });
    await expect(notificarRepasseDocs("c1", "u2")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("docs-notificar-repasse", {
      body: { conversa_id: "c1", to_user_id: "u2" },
    });
  });
});
