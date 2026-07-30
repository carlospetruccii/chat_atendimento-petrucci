// Testes do casamento eco x mensagem própria.
// Rodar: deno test supabase/functions/webhook-zapi-receive/eco-logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { candidatasParaAdocao, ecoCasaComCandidata } from "./eco-logic.ts";

const cand = (over: Partial<Parameters<typeof ecoCasaComCandidata>[0]> = {}) => ({
  id: "m1",
  tipo: "texto",
  content: "Bom dia",
  media_metadata: null,
  created_at: "2026-07-30T12:00:00.000Z",
  ...over,
});

Deno.test("texto: casa quando o conteúdo é o mesmo (ignorando espaços)", () => {
  const ok = ecoCasaComCandidata(cand(), {
    tipo: "texto",
    content: "  Bom   dia ",
    media_metadata: null,
  });
  assertEquals(ok, true);
});

Deno.test("texto: NÃO casa com conteúdo diferente", () => {
  const ok = ecoCasaComCandidata(cand(), {
    tipo: "texto",
    content: "Boa tarde",
    media_metadata: null,
  });
  assertEquals(ok, false);
});

Deno.test("tipo diferente nunca casa", () => {
  const ok = ecoCasaComCandidata(cand({ tipo: "documento", content: null }), {
    tipo: "imagem",
    content: null,
    media_metadata: null,
  });
  assertEquals(ok, false);
});

Deno.test("documento: casa pelo nome do arquivo (chaves diferentes nos dois lados)", () => {
  const ok = ecoCasaComCandidata(
    cand({ tipo: "documento", content: null, media_metadata: { nome_original: "Balanco.PDF" } }),
    { tipo: "documento", content: null, media_metadata: { file_name: "balanco.pdf" } },
  );
  assertEquals(ok, true);
});

Deno.test("documento: NÃO casa quando os dois lados têm nomes diferentes", () => {
  const ok = ecoCasaComCandidata(
    cand({ tipo: "documento", content: null, media_metadata: { file_name: "nota.pdf" } }),
    { tipo: "documento", content: null, media_metadata: { file_name: "balanco.pdf" } },
  );
  assertEquals(ok, false);
});

Deno.test("mídia: nome ausente de um lado não desqualifica", () => {
  const ok = ecoCasaComCandidata(
    cand({ tipo: "documento", content: null, media_metadata: { file_name: "nota.pdf" } }),
    { tipo: "documento", content: null, media_metadata: { mime_type: "application/pdf" } },
  );
  assertEquals(ok, true);
});

Deno.test("mídia: legenda diferente nos dois lados desqualifica", () => {
  const ok = ecoCasaComCandidata(
    cand({ tipo: "imagem", content: "foto do contrato", media_metadata: null }),
    { tipo: "imagem", content: "outra coisa", media_metadata: null },
  );
  assertEquals(ok, false);
});

Deno.test("ordena as candidatas da mais antiga para a mais nova (FIFO)", () => {
  const nova = cand({ id: "nova", created_at: "2026-07-30T12:05:00.000Z" });
  const antiga = cand({ id: "antiga", created_at: "2026-07-30T12:01:00.000Z" });
  const outra = cand({ id: "outra", content: "Tchau" });

  const r = candidatasParaAdocao([nova, antiga, outra], {
    tipo: "texto",
    content: "Bom dia",
    media_metadata: null,
  });

  assertEquals(r.map((c) => c.id), ["antiga", "nova"]);
});

Deno.test("sem candidata compatível retorna lista vazia", () => {
  const r = candidatasParaAdocao([cand()], {
    tipo: "documento",
    content: null,
    media_metadata: { file_name: "x.pdf" },
  });
  assertEquals(r.length, 0);
});
