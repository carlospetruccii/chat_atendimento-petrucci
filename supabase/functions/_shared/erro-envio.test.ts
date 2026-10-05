// Testes do classificador de erro de envio.
// Rodar: deno test supabase/functions/_shared/erro-envio.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  atualizacaoAposErroEnvio,
  envioIndeterminado,
  motivoLegivel,
} from "./erro-envio.ts";
import { UazapiError } from "./uazapi-client.ts";

const AGORA = "2026-09-28T11:16:54.000Z";

function abortError(): Error {
  // O que o fetch do Deno rejeita quando o AbortController dispara.
  const e = new DOMException("The signal has been aborted", "AbortError");
  return e as unknown as Error;
}

// ————————————————————————————— envioIndeterminado

Deno.test("envioIndeterminado: abort do nosso timeout é indeterminado", () => {
  // Arrange
  const err = abortError();

  // Act / Assert
  assertEquals(envioIndeterminado(err), true);
});

Deno.test("envioIndeterminado: timeout por nome também conta", () => {
  const err = new Error("deu ruim");
  err.name = "TimeoutError";
  assertEquals(envioIndeterminado(err), true);
});

Deno.test("envioIndeterminado: queda de conexão é indeterminada", () => {
  assertEquals(envioIndeterminado(new TypeError("error sending request for url")), true);
  assertEquals(envioIndeterminado(new Error("connection closed before message completed")), true);
  assertEquals(envioIndeterminado(new Error("connection reset by peer")), true);
});

Deno.test("envioIndeterminado: resposta HTTP da uazapi NÃO é indeterminada", () => {
  // A uazapi respondeu — a mensagem não saiu.
  assertEquals(envioIndeterminado(new UazapiError("erro 400", 400, "{}")), false);
  assertEquals(envioIndeterminado(new UazapiError("erro 500", 500, "{}")), false);
  assertEquals(envioIndeterminado(new UazapiError("rate limit", 429, "{}")), false);
});

Deno.test("envioIndeterminado: erro de validação nosso NÃO é indeterminado", () => {
  // Nem chegou a sair da função — repescar seria reenviar lixo.
  assertEquals(envioIndeterminado(new Error("Mensagem texto sem conteúdo")), false);
  assertEquals(envioIndeterminado(new Error("media_url ausente ou inválida")), false);
  assertEquals(envioIndeterminado("string solta"), false);
  assertEquals(envioIndeterminado(null), false);
});

// ————————————————————————————— atualizacaoAposErroEnvio

Deno.test("atualizacaoAposErroEnvio: indeterminado fica em 'enviando' com carimbo", () => {
  // Arrange
  const meta = { file_name: "guia.pdf" };

  // Act
  const upd = atualizacaoAposErroEnvio(abortError(), meta, { agoraIso: AGORA });

  // Assert
  assertEquals(upd.status_envio, "enviando");
  assertEquals(upd.media_metadata, {
    file_name: "guia.pdf",
    envio_incerto_em: AGORA,
    envio_incerto_motivo: "Sem resposta do WhatsApp (pode ter sido enviada)",
  });
});

Deno.test("atualizacaoAposErroEnvio: indeterminado não grava erro_motivo", () => {
  // erro_motivo pinta a bolha de vermelho na Inbox — e ainda não sabemos se falhou.
  const upd = atualizacaoAposErroEnvio(abortError(), null, { agoraIso: AGORA });
  assertEquals("erro_motivo" in upd.media_metadata, false);
});

Deno.test("atualizacaoAposErroEnvio: erro claro vira 'falha' com motivo", () => {
  // Arrange
  const err = new UazapiError("uazapi erro HTTP 401", 401, "{}");

  // Act
  const upd = atualizacaoAposErroEnvio(err, { file_name: "x.pdf" }, { agoraIso: AGORA });

  // Assert
  assertEquals(upd.status_envio, "falha");
  assertEquals(upd.media_metadata, {
    file_name: "x.pdf",
    erro_motivo: "WhatsApp recusou a credencial (verifique a conexão)",
  });
});

Deno.test("atualizacaoAposErroEnvio: falha depois de incerto limpa o carimbo", () => {
  // Retry do cron falhou de verdade: o carimbo antigo não pode sobreviver,
  // senão a varredura promoveria a mesma linha de novo.
  const meta = { envio_incerto_em: "2026-09-28T11:00:00.000Z", envio_incerto_motivo: "x" };

  const upd = atualizacaoAposErroEnvio(new UazapiError("400", 400, "{}"), meta, { agoraIso: AGORA });

  assertEquals(upd.status_envio, "falha");
  assertEquals("envio_incerto_em" in upd.media_metadata, false);
  assertEquals("envio_incerto_motivo" in upd.media_metadata, false);
});

Deno.test("atualizacaoAposErroEnvio: sanitizarMotivo limpa o que vai pro banco", () => {
  // Arrange
  const err = new UazapiError("http 400", 400, JSON.stringify({ error: "falhou https://x.co/a?token=abc" }));

  // Act
  const upd = atualizacaoAposErroEnvio(err, null, {
    agoraIso: AGORA,
    sanitizarMotivo: (m) => m.replace(/https?:\/\/\S+/g, "[url]"),
  });

  // Assert
  assertEquals(upd.media_metadata.erro_motivo, "falhou [url]");
});

Deno.test("atualizacaoAposErroEnvio: sem sanitizador, tira URL do motivo mesmo assim", () => {
  // Arrange — o corpo de erro da uazapi pode ecoar a signed URL da mídia.
  const err = new UazapiError("http 400", 400, JSON.stringify({ error: "falhou https://x.co/a?token=abc" }));

  // Act
  const upd = atualizacaoAposErroEnvio(err, null, { agoraIso: AGORA });

  // Assert
  assertEquals(upd.media_metadata.erro_motivo, "falhou [url]");
});

Deno.test("atualizacaoAposErroEnvio: não muta o metadata recebido", () => {
  const meta = { file_name: "a.pdf" };
  atualizacaoAposErroEnvio(abortError(), meta, { agoraIso: AGORA });
  assertEquals(meta, { file_name: "a.pdf" });
});

// ————————————————————————————— motivoLegivel

Deno.test("motivoLegivel: usa o corpo JSON da uazapi quando existe", () => {
  const err = new UazapiError("http 400", 400, JSON.stringify({ error: "number not found" }));
  assertEquals(motivoLegivel(err), "number not found");
});

Deno.test("motivoLegivel: status conhecidos viram texto de gente", () => {
  assertEquals(motivoLegivel(new UazapiError("x", 429, "")), "WhatsApp indisponível (limite de requisições)");
  assertEquals(motivoLegivel(new UazapiError("x", 503, "")), "WhatsApp indisponível");
  assertEquals(motivoLegivel(new UazapiError("x", 404, "")), "Recurso não encontrado no WhatsApp");
  assertEquals(motivoLegivel(new UazapiError("x", 400, "nao-json")), "Dados inválidos para envio (verifique número/mídia)");
});

Deno.test("motivoLegivel: corta mensagem longa em 140 caracteres", () => {
  const longa = "z".repeat(300);
  assertEquals(motivoLegivel(new Error(longa)).length, 140);
});

Deno.test("motivoLegivel: desconhecido tem texto genérico", () => {
  assertEquals(motivoLegivel(undefined), "Falha desconhecida no envio");
});
