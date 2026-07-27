// Testes da validação de envio para grupo.
// Rodar: deno test supabase/functions/grupo-enviar/logic.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bytesAproximadosDeBase64,
  deduzirExtensao,
  MAX_CHARS_TEXTO,
  validarEnvioGrupo,
} from "./logic.ts";

const GRUPO = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

Deno.test("texto válido passa", () => {
  const r = validarEnvioGrupo({ grupo_id: GRUPO, tipo: "texto", content: "  Bom dia  " });
  assert(r.ok);
  assertEquals(r.envio.content, "Bom dia");
  assertEquals(r.envio.tipo, "texto");
  assertEquals(r.envio.arquivoBase64, null);
});

Deno.test("sem grupo_id é rejeitado", () => {
  const r = validarEnvioGrupo({ tipo: "texto", content: "oi" });
  assert(!r.ok);
  assertEquals(r.erro, "grupo_id_obrigatorio");
  assertEquals(r.status, 400);
});

Deno.test("tipo desconhecido é rejeitado", () => {
  const r = validarEnvioGrupo({ grupo_id: GRUPO, tipo: "figurinha", content: "x" });
  assert(!r.ok);
  assertEquals(r.erro, "tipo_invalido");
});

Deno.test("texto vazio ou só espaços é rejeitado", () => {
  for (const content of ["", "   ", undefined]) {
    const r = validarEnvioGrupo({ grupo_id: GRUPO, tipo: "texto", content });
    assert(!r.ok);
    assertEquals(r.erro, "mensagem_vazia");
  }
});

Deno.test("texto acima do limite é rejeitado", () => {
  const r = validarEnvioGrupo({
    grupo_id: GRUPO,
    tipo: "texto",
    content: "a".repeat(MAX_CHARS_TEXTO + 1),
  });
  assert(!r.ok);
  assertEquals(r.erro, "mensagem_muito_longa");
  assertEquals(r.status, 413);
});

Deno.test("mídia sem arquivo é rejeitada", () => {
  const r = validarEnvioGrupo({ grupo_id: GRUPO, tipo: "image", content: "legenda" });
  assert(!r.ok);
  assertEquals(r.erro, "arquivo_obrigatorio");
});

Deno.test("arquivo acima de 16 MB é rejeitado antes de decodificar", () => {
  // 24 MB de base64 ≈ 18 MB de bytes.
  const r = validarEnvioGrupo({
    grupo_id: GRUPO,
    tipo: "document",
    arquivo_base64: "A".repeat(24 * 1024 * 1024),
    nome_arquivo: "grande.pdf",
  });
  assert(!r.ok);
  assertEquals(r.erro, "arquivo_muito_grande");
});

Deno.test("legenda de imagem é truncada em 1024 caracteres", () => {
  const r = validarEnvioGrupo({
    grupo_id: GRUPO,
    tipo: "image",
    arquivo_base64: "AAAA",
    content: "x".repeat(2000),
  });
  assert(r.ok);
  assertEquals(r.envio.content?.length, 1024);
});

Deno.test("áudio nunca leva legenda", () => {
  const r = validarEnvioGrupo({
    grupo_id: GRUPO,
    tipo: "audio",
    arquivo_base64: "AAAA",
    content: "isso viraria texto fantasma",
    duracao_seg: 12.6,
  });
  assert(r.ok);
  assertEquals(r.envio.content, null);
  assertEquals(r.envio.duracaoSeg, 13);
});

Deno.test("duração só é guardada para áudio", () => {
  const r = validarEnvioGrupo({
    grupo_id: GRUPO,
    tipo: "video",
    arquivo_base64: "AAAA",
    duracao_seg: 30,
  });
  assert(r.ok);
  assertEquals(r.envio.duracaoSeg, null);
});

Deno.test("duração inválida não explode", () => {
  const r = validarEnvioGrupo({
    grupo_id: GRUPO,
    tipo: "audio",
    arquivo_base64: "AAAA",
    duracao_seg: Number.NaN,
  });
  assert(r.ok);
  assertEquals(r.envio.duracaoSeg, null);
});

Deno.test("reply_to_message_id vazio vira null", () => {
  const r = validarEnvioGrupo({
    grupo_id: GRUPO,
    tipo: "texto",
    content: "oi",
    reply_to_message_id: "   ",
  });
  assert(r.ok);
  assertEquals(r.envio.replyToMessageId, null);
});

Deno.test("bytesAproximadosDeBase64 aproxima 3/4 do tamanho", () => {
  assertEquals(bytesAproximadosDeBase64("AAAA"), 3);
  assertEquals(bytesAproximadosDeBase64(""), 0);
});

Deno.test("deduzirExtensao: nome do arquivo tem prioridade", () => {
  assertEquals(deduzirExtensao("contrato.PDF", "application/octet-stream", "document"), "pdf");
});

Deno.test("deduzirExtensao: cai para o mime type", () => {
  assertEquals(deduzirExtensao("arquivo", "image/png", "image"), "png");
  assertEquals(deduzirExtensao("arquivo", "audio/ogg; codecs=opus", "audio"), "ogg");
});

Deno.test("deduzirExtensao: fallback por tipo quando nada bate", () => {
  assertEquals(deduzirExtensao("arquivo", "application/x-esquisito", "audio"), "ogg");
  assertEquals(deduzirExtensao("arquivo", "application/x-esquisito", "document"), "bin");
});
