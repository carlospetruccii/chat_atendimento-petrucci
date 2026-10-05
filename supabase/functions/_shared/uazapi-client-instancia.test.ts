// Testes da escolha de instância (número principal x financeiro) no cliente
// da uazapi. O que importa aqui é que NENHUM chamador antigo muda de
// comportamento (sem `instancia` = principal) e que o financeiro usa o token
// dele — mandar pelo número errado seria o pior bug possível desta feature.
//
// Rodar: deno test --allow-env supabase/functions/_shared/uazapi-client-instancia.test.ts

import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  baixarMidiaMensagem,
  deletarMensagem,
  editarMensagem,
  enviarMidia,
  enviarTexto,
  marcarChatComoLido,
  statusInstancia,
  verWebhook,
} from "./uazapi-client.ts";

interface Chamada {
  url: string;
  token: string | null;
  corpo: Record<string, unknown> | null;
}

function comEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  return async () => {
    const antes: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      antes[k] = Deno.env.get(k);
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(antes)) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    }
  };
}

async function capturar(fn: () => Promise<unknown>): Promise<Chamada[]> {
  const chamadas: Chamada[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    chamadas.push({
      url: String(input),
      token: headers.get("token"),
      corpo: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ id: "owner:abc" }), { status: 200 }),
    );
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return chamadas;
}

const ENV_PADRAO = {
  UAZAPI_URL: "https://principal.uazapi.test/",
  UAZAPI_TOKEN: "tok-principal",
  UAZAPI_TOKEN_FINANCEIRO: "tok-financeiro",
  UAZAPI_URL_FINANCEIRO: undefined,
};

Deno.test(
  "sem instancia: continua usando o token principal (chamadores antigos intactos)",
  comEnv(ENV_PADRAO, async () => {
    const [c] = await capturar(() => enviarTexto({ telefone: "5511999998888", mensagem: "oi" }));
    assertEquals(c.token, "tok-principal");
    assertEquals(c.url, "https://principal.uazapi.test/send/text");
  }),
);

Deno.test(
  "instancia financeiro: envio de texto usa o token do financeiro",
  comEnv(ENV_PADRAO, async () => {
    const [c] = await capturar(() =>
      enviarTexto({ telefone: "5511999998888", mensagem: "oi", instancia: "financeiro" })
    );
    assertEquals(c.token, "tok-financeiro");
    // Sem URL própria, o financeiro mora no mesmo servidor da conta.
    assertEquals(c.url, "https://principal.uazapi.test/send/text");
  }),
);

Deno.test(
  "instancia financeiro: UAZAPI_URL_FINANCEIRO tem prioridade quando existe",
  comEnv({ ...ENV_PADRAO, UAZAPI_URL_FINANCEIRO: "https://fin.uazapi.test" }, async () => {
    const [c] = await capturar(() =>
      enviarTexto({ telefone: "5511999998888", mensagem: "oi", instancia: "financeiro" })
    );
    assertEquals(c.url, "https://fin.uazapi.test/send/text");
  }),
);

Deno.test(
  "instancia financeiro: todas as operações do chat respeitam a instância",
  comEnv(ENV_PADRAO, async () => {
    const chamadas = await capturar(async () => {
      await enviarMidia({
        telefone: "5511999998888",
        tipo: "document",
        url: "https://x/y.pdf",
        instancia: "financeiro",
      });
      await deletarMensagem({ zapiMessageId: "owner:1", instancia: "financeiro" });
      await editarMensagem({ zapiMessageId: "owner:1", texto: "novo", instancia: "financeiro" });
      await baixarMidiaMensagem("owner:1", { instancia: "financeiro" });
      await marcarChatComoLido("5511999998888", "financeiro");
      await statusInstancia("financeiro");
      await verWebhook("financeiro");
    });
    assertEquals(chamadas.length, 7);
    for (const c of chamadas) assertEquals(c.token, "tok-financeiro", c.url);
  }),
);

Deno.test(
  "instancia financeiro sem o secret: falha alto em vez de cair no número principal",
  comEnv({ ...ENV_PADRAO, UAZAPI_TOKEN_FINANCEIRO: undefined }, async () => {
    await assertRejects(
      () => enviarTexto({ telefone: "5511999998888", mensagem: "oi", instancia: "financeiro" }),
      Error,
      "UAZAPI_TOKEN_FINANCEIRO",
    );
  }),
);

Deno.test(
  "rastreio: vai como track_source/track_id no envio (e só quando pedido)",
  comEnv(ENV_PADRAO, async () => {
    const [comMarca, semMarca, midia] = await capturar(async () => {
      await enviarTexto({
        telefone: "5511999998888",
        mensagem: "oi",
        instancia: "financeiro",
        rastreio: { origem: "chatatendimento-docs", id: "linha-1" },
      });
      await enviarTexto({ telefone: "5511999998888", mensagem: "oi" });
      await enviarMidia({
        telefone: "5511999998888",
        tipo: "image",
        url: "https://x/y.png",
        instancia: "financeiro",
        rastreio: { origem: "chatatendimento-docs", id: "linha-2" },
      });
    });
    assertEquals(comMarca.corpo?.track_source, "chatatendimento-docs");
    assertEquals(comMarca.corpo?.track_id, "linha-1");
    assertEquals("track_source" in (semMarca.corpo ?? {}), false);
    assertEquals(midia.corpo?.track_id, "linha-2");
  }),
);
