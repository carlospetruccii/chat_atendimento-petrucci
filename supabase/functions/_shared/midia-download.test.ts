// Testes da escolha de caminho do download de mídia.
//
// O bug que motivou estes testes: um .rar de poucos MB derrubava o
// /message/download com return_base64 no timeout, e como as três tentativas
// dividiam o MESMO try/catch, o erro da primeira cancelava as outras duas — a
// mídia virava "indisponível" para sempre.

import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  abrirMidia,
  contentTypeSeguro,
  deduzirExtensao,
  type DepsBytesMidia,
  MAX_BYTES,
  MidiaGrandeDemais,
  type MidiaObtida,
  obterMidia,
} from "./midia-download.ts";

const BYTES = new Uint8Array([1, 2, 3, 4]);

function deps(over: Partial<DepsBytesMidia>): DepsBytesMidia {
  return {
    baixar: () => Promise.resolve({}),
    abrir: () => Promise.resolve(null),
    ...over,
  } as DepsBytesMidia;
}

function emBytes(buf: Uint8Array, contentType: string | null, fonte: string): MidiaObtida {
  return { modo: "bytes", buf, contentType, fonte };
}

/** Só o modo `bytes` tem buf; o de stream não carrega o arquivo. */
function bufDe(m: MidiaObtida): Uint8Array {
  if (m.modo !== "bytes") throw new Error(`esperava bytes, veio ${m.modo}`);
  return m.buf;
}

Deno.test("usa a fileURL da uazapi antes de pedir base64", async () => {
  const chamadas: Array<boolean | undefined> = [];
  const r = await obterMidia(
    null,
    "owner:abc",
    deps({
      baixar: (_id, opts) => {
        chamadas.push(opts?.retornarBase64);
        return Promise.resolve({
          url: "https://cdn.uazapi.com/a.rar",
          mimetype: "application/vnd.rar",
        });
      },
      abrir: (alvo, fonte) => {
        assertEquals(alvo, "https://cdn.uazapi.com/a.rar");
        return Promise.resolve(emBytes(BYTES, null, fonte));
      },
    }),
  );

  assertEquals(r.fonte, "message_download_url");
  assertEquals(r.contentType, "application/vnd.rar");
  // Uma chamada só, e SEM base64 — o caminho caro nem é tentado.
  assertEquals(chamadas, [undefined]);
});

Deno.test("timeout na fileURL não impede a tentativa com base64", async () => {
  const r = await obterMidia(
    null,
    "owner:abc",
    deps({
      baixar: (_id, opts) => {
        if (opts?.retornarBase64 !== true) {
          const err = new Error("aborted");
          err.name = "TimeoutError";
          return Promise.reject(err);
        }
        return Promise.resolve({ base64: btoa("rar"), mimetype: "application/x-compressed" });
      },
    }),
  );

  assertEquals(r.fonte, "message_download_base64");
  assertEquals(new TextDecoder().decode(bufDe(r)), "rar");
});

Deno.test("cai para a url do webhook quando o endpoint não entrega nada", async () => {
  const r = await obterMidia(
    "https://mmg.whatsapp.net/x.enc",
    "owner:abc",
    deps({
      baixar: () => Promise.reject(new Error("uazapi erro HTTP 500")),
      abrir: (alvo, fonte) =>
        alvo === "https://mmg.whatsapp.net/x.enc"
          ? Promise.resolve(emBytes(BYTES, "application/octet-stream", fonte))
          : Promise.resolve(null),
    }),
  );

  assertEquals(r.fonte, "url_original");
});

Deno.test("erro final lista o motivo de cada tentativa", async () => {
  const err = await assertRejects(
    () =>
      obterMidia(
        null,
        "owner:abc",
        deps({
          baixar: () => {
            const e = new Error("aborted");
            e.name = "TimeoutError";
            return Promise.reject(e);
          },
        }),
      ),
    Error,
  );

  // Sem os motivos, o log dizia só "/message/download" e não dava para saber
  // se foi timeout, 500 ou resposta vazia.
  assertEquals(err.message.includes("tempo esgotado"), true);
});

Deno.test("extensão de compactados sai do mime, não do fallback", () => {
  assertEquals(deduzirExtensao("application/x-compressed", "bin"), "rar");
  assertEquals(deduzirExtensao("application/vnd.rar", "bin"), "rar");
  assertEquals(deduzirExtensao("application/zip; charset=binary", "bin"), "zip");
  assertEquals(deduzirExtensao("application/x-desconhecido", "bin"), "bin");
});

Deno.test("content-type de terceiro nunca vira html no bucket", () => {
  assertEquals(contentTypeSeguro("text/html"), "application/octet-stream");
  assertEquals(contentTypeSeguro("image/svg+xml"), "application/octet-stream");
  assertEquals(contentTypeSeguro("application/x-rar-compressed"), "application/x-rar-compressed");
  assertEquals(contentTypeSeguro("APPLICATION/PDF; x=1"), "application/pdf");
});


// —————————————————————————————————————————————————————————————————
// Teto de tamanho. O .rar que motivou tudo isto matou o isolate com
// "Memory limit exceeded": o corpo era lido inteiro ANTES de qualquer
// checagem, e o teto de 16 MB não tinha relação com o que o cliente pode
// mandar — só com o limite de ENVIO da uazapi.
// —————————————————————————————————————————————————————————————————

function respostaFalsa(bytes: number, declararTamanho: boolean): Response {
  const pedaco = new Uint8Array(1024);
  let restante = bytes;
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (restante <= 0) return ctrl.close();
      const n = Math.min(pedaco.byteLength, restante);
      restante -= n;
      ctrl.enqueue(pedaco.subarray(0, n));
    },
  });
  const headers = new Headers({ "content-type": "application/x-rar-compressed" });
  if (declararTamanho) headers.set("content-length", String(bytes));
  return new Response(body, { headers });
}

Deno.test("o teto acompanha o Storage do projeto (50 MiB, plano Free)", () => {
  assertEquals(MAX_BYTES, 50 * 1024 * 1024);
});

Deno.test("arquivo além do teto recusa pelo content-length, sem ler o corpo", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(respostaFalsa(MAX_BYTES + 1, true));
  try {
    const err = await assertRejects(
      () => abrirMidia("https://cdn.uazapi.com/gigante.rar", "teste"),
      MidiaGrandeDemais,
    );
    assertEquals(err.bytes, MAX_BYTES + 1);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("sem content-length, corta durante a leitura em vez de estourar a memória", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(respostaFalsa(MAX_BYTES + 4096, false));
  try {
    await assertRejects(
      () => abrirMidia("https://cdn.uazapi.com/sem-tamanho.rar", "teste"),
      MidiaGrandeDemais,
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("arquivo pequeno vem em bytes, do jeito simples", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(respostaFalsa(3 * 1024 * 1024, true));
  try {
    const r = await abrirMidia("https://cdn.uazapi.com/ok.rar", "teste");
    assertEquals(r?.modo, "bytes");
    assertEquals(bufDe(r!).byteLength, 3 * 1024 * 1024);
    assertEquals(r?.contentType, "application/x-rar-compressed");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("arquivo grande vem em stream, sem carregar na memória", async () => {
  const original = globalThis.fetch;
  // Acima do LIMITE_BUFFER (24 MB) e abaixo do teto do Storage (50 MiB).
  const tamanho = 40 * 1024 * 1024;
  globalThis.fetch = () => Promise.resolve(respostaFalsa(tamanho, true));
  try {
    const r = await abrirMidia("https://cdn.uazapi.com/grande.rar", "teste");
    assertEquals(r?.modo, "stream");
    if (r?.modo !== "stream") throw new Error("esperava stream");
    assertEquals(r.tamanho, tamanho);
    // Nada foi lido ainda: o corpo é entregue intacto para o upload em blocos.
    await r.corpo.cancel();
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("grande demais não tenta base64 depois — seria o mesmo arquivo", async () => {
  let chamadasBase64 = 0;
  await assertRejects(
    () =>
      obterMidia(
        "https://mmg.whatsapp.net/x.enc",
        "owner:abc",
        deps({
          baixar: (_id, opts) => {
            if (opts?.retornarBase64 === true) chamadasBase64++;
            return Promise.resolve({ url: "https://cdn.uazapi.com/gigante.rar" });
          },
          abrir: () => Promise.reject(new MidiaGrandeDemais(400 * 1048576)),
        }),
      ),
    MidiaGrandeDemais,
  );
  assertEquals(chamadasBase64, 0);
});

Deno.test("baixa pela instância pedida (Docs usa o número financeiro)", async () => {
  const instanciasVistas: (string | undefined)[] = [];
  const r = await obterMidia(
    null,
    "owner:1",
    deps({
      baixar: (_id, opts) => {
        instanciasVistas.push(opts?.instancia);
        return Promise.resolve(opts?.retornarBase64 ? { base64: btoa("\x01\x02") } : {});
      },
    }),
    "financeiro",
  );
  assertEquals(bufDe(r).byteLength, 2);
  assertEquals(instanciasVistas, ["financeiro", "financeiro"]);
});

Deno.test("sem instância, o download continua no número principal", async () => {
  const instanciasVistas: (string | undefined)[] = [];
  await obterMidia(
    null,
    "owner:1",
    deps({
      baixar: (_id, opts) => {
        instanciasVistas.push(opts?.instancia);
        return Promise.resolve({ base64: btoa("\x01") });
      },
    }),
  );
  assertEquals(instanciasVistas, [undefined]);
});
