// Testes da lógica pura de encaminhar mensagem.
// Rodar: deno test supabase/functions/mensagem-encaminhar/logic.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  avaliarEncaminhar,
  extensaoDoOriginal,
  type MensagemEncaminhavel,
  metadataEncaminhada,
  novoStoragePath,
  TIPO_PARA_UAZAPI,
} from "./logic.ts";

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

Deno.test("permite mensagem de texto outbound comum", () => {
  assertEquals(avaliarEncaminhar(mensagem()), { pode: true });
});

Deno.test("permite mensagem inbound do cliente (diferente de editar/apagar)", () => {
  assertEquals(avaliarEncaminhar(mensagem({ senderType: "cliente" })), { pode: true });
});

Deno.test("permite mídia (imagem, áudio, vídeo, documento)", () => {
  for (const tipo of ["imagem", "audio", "video", "documento"]) {
    assertEquals(avaliarEncaminhar(mensagem({ tipo })), { pode: true });
  }
});

Deno.test("bloqueia mídia cujo download falhou (sem storage_path no bucket)", () => {
  for (const tipo of ["imagem", "audio", "video", "documento"]) {
    const r = avaliarEncaminhar(mensagem({ tipo, midiaPronta: false }));
    assert(!r.pode);
    assertEquals(r.motivo, "midia_indisponivel");
  }
});

Deno.test("texto não depende de mídia pronta", () => {
  assertEquals(avaliarEncaminhar(mensagem({ tipo: "texto", midiaPronta: false })), { pode: true });
});

Deno.test("bloqueia mensagem apagada", () => {
  const r = avaliarEncaminhar(mensagem({ apagadaEm: "2026-08-06T12:00:00.000Z" }));
  assert(!r.pode);
  assertEquals(r.motivo, "ja_apagada");
});

Deno.test("bloqueia aviso interno do sistema", () => {
  const r = avaliarEncaminhar(mensagem({ senderType: "sistema" }));
  assert(!r.pode);
  assertEquals(r.motivo, "aviso_interno");
});

Deno.test("bloqueia menu/lista interativa", () => {
  const r = avaliarEncaminhar(mensagem({ ehListaOpcoes: true }));
  assert(!r.pode);
  assertEquals(r.motivo, "menu_interativo");
});

Deno.test("bloqueia tipo sem suporte a envio (ex.: figurinha, localização, contato)", () => {
  for (const tipo of ["sticker", "localizacao", "contato"]) {
    const r = avaliarEncaminhar(mensagem({ tipo }));
    assert(!r.pode);
    assertEquals(r.motivo, "tipo_nao_suportado");
  }
});

Deno.test("apagada tem prioridade sobre os demais motivos", () => {
  const r = avaliarEncaminhar(
    mensagem({ apagadaEm: "2026-08-06T12:00:00.000Z", senderType: "sistema" }),
  );
  assert(!r.pode);
  assertEquals(r.motivo, "ja_apagada");
});

Deno.test("TIPO_PARA_UAZAPI cobre os quatro tipos de mídia encaminháveis", () => {
  assertEquals(TIPO_PARA_UAZAPI.imagem, "image");
  assertEquals(TIPO_PARA_UAZAPI.audio, "audio");
  assertEquals(TIPO_PARA_UAZAPI.video, "video");
  assertEquals(TIPO_PARA_UAZAPI.documento, "document");
});

Deno.test("extensaoDoOriginal: usa media_metadata.extensao quando presente", () => {
  assertEquals(extensaoDoOriginal({ extensao: "PDF" }, "outbound/x/y.bin"), "PDF");
});

Deno.test("extensaoDoOriginal: cai para a extensão do storage_path", () => {
  assertEquals(extensaoDoOriginal({}, "outbound/x/y.jpg"), "jpg");
});

Deno.test("extensaoDoOriginal: fallback 'bin' quando não há nenhuma pista", () => {
  assertEquals(extensaoDoOriginal({}, "outbound/x/sem-extensao"), "bin");
});

Deno.test("novoStoragePath nunca reaproveita o path da origem", () => {
  const path = novoStoragePath("atendimento-1", "uuid-1", "jpg");
  assertEquals(path, "encaminhadas/atendimento-1/uuid-1.jpg");
});

Deno.test("metadataEncaminhada carrega só os campos conhecidos do original", () => {
  const meta = metadataEncaminhada({
    original: {
      storage_path: "outbound/x/y.jpg",
      mime_type: "image/jpeg",
      file_name: "foto.jpg",
      extensao: "jpg",
      tamanho_bytes: 1234,
      erro_motivo: "isso não deveria ir para a mensagem nova", // campo extra
      apagada: true, // campo extra
    } as never,
    novoPath: "encaminhadas/dest/uuid.jpg",
    mensagemOrigemId: "msg-origem-1",
  });
  assertEquals(meta, {
    storage_path: "encaminhadas/dest/uuid.jpg",
    bucket: "mensagens-midia",
    encaminhada_de_mensagem_id: "msg-origem-1",
    mime_type: "image/jpeg",
    file_name: "foto.jpg",
    extensao: "jpg",
    tamanho_bytes: 1234,
  });
});

Deno.test("metadataEncaminhada carrega duracao_seg quando presente (áudio)", () => {
  const meta = metadataEncaminhada({
    original: { extensao: "ogg", duracao_seg: 12 },
    novoPath: "encaminhadas/dest/uuid.ogg",
    mensagemOrigemId: "msg-origem-2",
  });
  assertEquals(meta.duracao_seg, 12);
});
