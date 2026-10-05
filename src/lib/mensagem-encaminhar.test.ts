import { describe, expect, test } from "vitest";
import {
  avaliarEncaminhar,
  explicarMotivoEncaminhar,
  type MensagemEncaminhavel,
  paraEncaminhavel,
} from "@/lib/mensagem-encaminhar";
import type { InboxMessage } from "@/lib/inbox-queries";

function mensagem(over: Partial<MensagemEncaminhavel> = {}): MensagemEncaminhavel {
  return {
    apagadaEm: null,
    senderType: "atendente",
    tipo: "texto",
    ehListaOpcoes: false,
    midiaPronta: true,
    ...over,
  };
}

describe("avaliarEncaminhar", () => {
  test("permite mensagem de texto outbound comum", () => {
    expect(avaliarEncaminhar(mensagem())).toEqual({ pode: true });
  });

  test("permite mensagem inbound do cliente (diferente de editar/apagar)", () => {
    expect(avaliarEncaminhar(mensagem({ senderType: "cliente" }))).toEqual({ pode: true });
  });

  test("permite mídia (imagem, áudio, vídeo, documento)", () => {
    for (const tipo of ["imagem", "audio", "video", "documento"]) {
      expect(avaliarEncaminhar(mensagem({ tipo }))).toEqual({ pode: true });
    }
  });

  test("bloqueia mídia cujo download falhou (sem storage_path no bucket)", () => {
    for (const tipo of ["imagem", "audio", "video", "documento"]) {
      expect(avaliarEncaminhar(mensagem({ tipo, midiaPronta: false }))).toEqual({
        pode: false,
        motivo: "midia_indisponivel",
      });
    }
  });

  test("texto não depende de mídia pronta", () => {
    expect(avaliarEncaminhar(mensagem({ tipo: "texto", midiaPronta: false }))).toEqual({
      pode: true,
    });
  });

  test("bloqueia mensagem apagada", () => {
    expect(avaliarEncaminhar(mensagem({ apagadaEm: "2026-08-06T12:00:00.000Z" }))).toEqual({
      pode: false,
      motivo: "ja_apagada",
    });
  });

  test("bloqueia aviso interno do sistema", () => {
    expect(avaliarEncaminhar(mensagem({ senderType: "sistema" }))).toEqual({
      pode: false,
      motivo: "aviso_interno",
    });
  });

  test("bloqueia menu/lista interativa", () => {
    expect(avaliarEncaminhar(mensagem({ ehListaOpcoes: true }))).toEqual({
      pode: false,
      motivo: "menu_interativo",
    });
  });

  test("bloqueia tipo sem suporte a envio (ex.: figurinha, localização, contato)", () => {
    for (const tipo of ["sticker", "localizacao", "contato"]) {
      expect(avaliarEncaminhar(mensagem({ tipo }))).toEqual({
        pode: false,
        motivo: "tipo_nao_suportado",
      });
    }
  });

  test("apagada tem prioridade sobre os demais motivos", () => {
    expect(
      avaliarEncaminhar(mensagem({ apagadaEm: "2026-08-06T12:00:00.000Z", senderType: "sistema" })),
    ).toEqual({ pode: false, motivo: "ja_apagada" });
  });
});

function inbox(over: Partial<InboxMessage> = {}): InboxMessage {
  return {
    apagadaEm: null,
    senderType: "cliente",
    tipo: "documento",
    mediaMetadata: null,
    ...over,
  } as InboxMessage;
}

describe("paraEncaminhavel", () => {
  test("mídia com download falhado não conta como pronta", () => {
    const m = inbox({
      mediaMetadata: { download_falhou: true, file_name: "contrato.rar" },
    });
    expect(avaliarEncaminhar(paraEncaminhavel(m))).toEqual({
      pode: false,
      motivo: "midia_indisponivel",
    });
  });

  test("mídia ainda baixando (sem storage_path) não conta como pronta", () => {
    expect(avaliarEncaminhar(paraEncaminhavel(inbox({ mediaMetadata: {} })))).toEqual({
      pode: false,
      motivo: "midia_indisponivel",
    });
  });

  test("mídia já no bucket é encaminhável", () => {
    const m = inbox({ mediaMetadata: { storage_path: "inbound/a/b.pdf" } });
    expect(avaliarEncaminhar(paraEncaminhavel(m))).toEqual({ pode: true });
  });

  test("texto sem media_metadata continua encaminhável", () => {
    expect(avaliarEncaminhar(paraEncaminhavel(inbox({ tipo: "texto" })))).toEqual({ pode: true });
  });
});

describe("explicarMotivoEncaminhar", () => {
  test("mídia indisponível tem frase própria, não a genérica", () => {
    const frase = explicarMotivoEncaminhar("midia_indisponivel");
    expect(frase).toContain("não está disponível");
    expect(frase).not.toBe("Não foi possível concluir.");
  });
});
