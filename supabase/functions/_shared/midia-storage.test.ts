// Testes do upload em blocos (tus).
//
// O que importa aqui é o fatiamento: o servidor só aceita blocos de exatamente
// 6 MB (menos o último) e rejeita qualquer offset fora de ordem. Um erro de
// contagem não dá erro visível — grava um arquivo CORROMPIDO no bucket.

import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { enviarStreamParaBucket } from "./midia-storage.ts";

const BLOCO = 6 * 1024 * 1024;

const CRED = { url: "https://projeto.supabase.co", chave: "chave-de-teste" };

interface Gravacao {
  blocos: Uint8Array[];
  offsets: number[];
  metadata: string | null;
}

/** Servidor tus falso: confere o offset e guarda o que recebeu. */
function servidorFalso(): { gravacao: Gravacao; fetch: typeof globalThis.fetch } {
  const gravacao: Gravacao = { blocos: [], offsets: [], metadata: null };
  let offset = 0;

  const fake = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const metodo = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (metodo === "POST") {
      gravacao.metadata = headers.get("upload-metadata");
      return new Response(null, {
        status: 201,
        headers: { location: "https://projeto.supabase.co/storage/v1/upload/resumable/abc" },
      });
    }
    const declarado = Number(headers.get("upload-offset"));
    if (declarado !== offset) {
      return new Response("offset fora de ordem", { status: 409 });
    }
    const corpo = new Uint8Array(await new Response(init?.body).arrayBuffer());
    gravacao.blocos.push(corpo);
    gravacao.offsets.push(declarado);
    offset += corpo.byteLength;
    return new Response(null, { status: 204, headers: { "upload-offset": String(offset) } });
  }) as unknown as typeof globalThis.fetch;

  return { gravacao, fetch: fake };
}

/** Origem que entrega o conteúdo em pedaços de tamanho irregular, como um CDN. */
function origem(total: number, pedaco: number): ReadableStream<Uint8Array> {
  let enviado = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (enviado >= total) return ctrl.close();
      const n = Math.min(pedaco, total - enviado);
      const parte = new Uint8Array(n);
      // Conteúdo previsível para conferir a ordem na remontagem.
      for (let i = 0; i < n; i++) parte[i] = (enviado + i) % 251;
      enviado += n;
      ctrl.enqueue(parte);
    },
  });
}

function remontado(g: Gravacao): Uint8Array {
  const total = g.blocos.reduce((s, b) => s + b.byteLength, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const b of g.blocos) {
    buf.set(b, off);
    off += b.byteLength;
  }
  return buf;
}

async function enviar(total: number, pedaco: number) {
  const original = globalThis.fetch;
  const { gravacao, fetch } = servidorFalso();
  globalThis.fetch = fetch;
  try {
    const r = await enviarStreamParaBucket({
      bucket: "mensagens-midia",
      path: "atendimento/mensagem.rar",
      contentType: "application/x-rar-compressed",
      corpo: origem(total, pedaco),
      tamanho: total,
      credenciais: CRED,
    });
    return { r, gravacao };
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("fatia em blocos de 6 MB, com o resto no último", async () => {
  const total = BLOCO * 2 + 1234;
  const { r, gravacao } = await enviar(total, 700_000);

  assertEquals(r.bytes, total);
  assertEquals(r.blocos, 3);
  assertEquals(gravacao.blocos.map((b) => b.byteLength), [BLOCO, BLOCO, 1234]);
  assertEquals(gravacao.offsets, [0, BLOCO, BLOCO * 2]);
});

Deno.test("remonta byte a byte na ordem certa", async () => {
  const total = BLOCO + 4096;
  const { gravacao } = await enviar(total, 999_983); // pedaço primo: nunca alinha

  const buf = remontado(gravacao);
  assertEquals(buf.byteLength, total);
  for (const i of [0, 1, BLOCO - 1, BLOCO, total - 1]) {
    assertEquals(buf[i], i % 251, `byte ${i} fora de lugar`);
  }
});

Deno.test("arquivo menor que um bloco vai num PATCH só", async () => {
  const { r, gravacao } = await enviar(1024, 1024);
  assertEquals(r.blocos, 1);
  assertEquals(gravacao.blocos[0].byteLength, 1024);
});

Deno.test("metadata carrega bucket e caminho em base64", async () => {
  const { gravacao } = await enviar(1024, 1024);
  const meta = gravacao.metadata ?? "";
  assertEquals(meta.includes(`bucketName ${btoa("mensagens-midia")}`), true);
  assertEquals(meta.includes(`objectName ${btoa("atendimento/mensagem.rar")}`), true);
});

Deno.test("origem que corta no meio não deixa arquivo truncado passar", async () => {
  const original = globalThis.fetch;
  const { fetch } = servidorFalso();
  globalThis.fetch = fetch;
  try {
    await assertRejects(
      () =>
        enviarStreamParaBucket({
          bucket: "mensagens-midia",
          path: "x.rar",
          contentType: "application/x-rar-compressed",
          // Declara 10 MB mas só entrega 1 MB.
          corpo: origem(1024 * 1024, 65536),
          tamanho: 10 * 1024 * 1024,
          credenciais: CRED,
        }),
      Error,
      "tus_incompleto",
    );
  } finally {
    globalThis.fetch = original;
  }
});
