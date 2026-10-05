// Upload de arquivo GRANDE para o Storage, em fluxo (protocolo tus).
//
// Por que não o upload comum: a Edge Function tem 256 MB de RAM e o
// `storage.upload()` quer o arquivo inteiro na memória. Um .rar de 250 MB mata
// o isolate com "Memory limit exceeded" — foi assim que a mídia sumia sem nem
// registrar a falha.
//
// Aqui o arquivo nunca existe inteiro em lugar nenhum: lê um bloco da origem,
// manda aquele bloco, descarta, repete. A memória fica no tamanho do bloco,
// tanto faz se o arquivo tem 60 MB ou 2 GB.

import { iniciarCronometro } from "./logger.ts";

/**
 * Tamanho do bloco do tus na Supabase: 6 MB, fixo. Blocos menores são recusados
 * (menos o último) e blocos maiores não são aceitos — é contrato do servidor,
 * não uma escolha de performance nossa.
 */
const BLOCO = 6 * 1024 * 1024;

const TUS_VERSAO = "1.0.0";

function base64(texto: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(texto)));
}

export interface CredenciaisStorage {
  url: string;
  chave: string;
}

function ambiente(cred?: CredenciaisStorage): CredenciaisStorage {
  const url = cred?.url ?? Deno.env.get("SUPABASE_URL");
  const chave = cred?.chave ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !chave) throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes");
  return { url: url.replace(/\/+$/, ""), chave };
}

export interface EnvioStreamParams {
  bucket: string;
  /** Caminho final dentro do bucket. */
  path: string;
  contentType: string;
  corpo: ReadableStream<Uint8Array>;
  /** Tamanho exato em bytes — o tus exige saber antes de começar. */
  tamanho: number;
  /** Injetável para o teste; em produção sai do ambiente da função. */
  credenciais?: CredenciaisStorage;
}

export interface EnvioStreamResultado {
  bytes: number;
  blocos: number;
  duracaoMs: number;
}

/** Abre o upload e devolve a URL para onde os blocos vão. */
async function criarUpload(p: EnvioStreamParams): Promise<string> {
  const { url, chave } = ambiente(p.credenciais);
  const metadata = [
    `bucketName ${base64(p.bucket)}`,
    `objectName ${base64(p.path)}`,
    `contentType ${base64(p.contentType)}`,
    `cacheControl ${base64("3600")}`,
  ].join(",");

  const resp = await fetch(`${url}/storage/v1/upload/resumable`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${chave}`,
      "tus-resumable": TUS_VERSAO,
      "upload-length": String(p.tamanho),
      "upload-metadata": metadata,
      // Reprocessamento reescreve o mesmo caminho em vez de dar conflito.
      "x-upsert": "true",
    },
  });
  if (!resp.ok) {
    throw new Error(`tus_criar: HTTP ${resp.status} ${(await resp.text()).slice(0, 120)}`);
  }
  const local = resp.headers.get("location");
  if (!local) throw new Error("tus_criar: resposta sem Location");
  // A Supabase devolve URL absoluta; o relativo é tolerado pelo protocolo.
  return local.startsWith("http") ? local : `${url}${local}`;
}

async function enviarBloco(
  destino: string,
  bloco: Uint8Array<ArrayBuffer>,
  offset: number,
  cred?: CredenciaisStorage,
): Promise<number> {
  const { chave } = ambiente(cred);
  const resp = await fetch(destino, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${chave}`,
      "tus-resumable": TUS_VERSAO,
      "upload-offset": String(offset),
      "content-type": "application/offset+octet-stream",
    },
    body: bloco,
  });
  if (!resp.ok) {
    throw new Error(`tus_bloco: HTTP ${resp.status} ${(await resp.text()).slice(0, 120)}`);
  }
  const novo = Number(resp.headers.get("upload-offset") ?? "NaN");
  if (!Number.isFinite(novo)) throw new Error("tus_bloco: resposta sem Upload-Offset");
  return novo;
}

/**
 * Consome o stream de origem e grava no bucket, bloco a bloco.
 * Devolve quantos bytes entraram — que TÊM que bater com `tamanho`, senão a
 * origem cortou no meio e o arquivo no bucket ficaria truncado.
 */
export async function enviarStreamParaBucket(
  p: EnvioStreamParams,
): Promise<EnvioStreamResultado> {
  const t = iniciarCronometro();
  const destino = await criarUpload(p);

  const reader = p.corpo.getReader();
  // Um único buffer reaproveitado: é a garantia de que a memória não cresce
  // com o tamanho do arquivo.
  const buffer = new Uint8Array(BLOCO);
  let preenchido = 0;
  let offset = 0;
  let blocos = 0;

  const despejar = async (ate: number) => {
    offset = await enviarBloco(destino, buffer.subarray(0, ate), offset, p.credenciais);
    blocos++;
    preenchido = 0;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      let consumido = 0;
      while (consumido < value.byteLength) {
        const cabe = Math.min(BLOCO - preenchido, value.byteLength - consumido);
        buffer.set(value.subarray(consumido, consumido + cabe), preenchido);
        preenchido += cabe;
        consumido += cabe;
        if (preenchido === BLOCO) await despejar(BLOCO);
      }
    }
    // Sobra final: o tus aceita bloco menor só no fim.
    if (preenchido > 0) await despejar(preenchido);
  } finally {
    reader.releaseLock();
  }

  if (offset !== p.tamanho) {
    throw new Error(`tus_incompleto: ${offset} de ${p.tamanho} bytes`);
  }
  return { bytes: offset, blocos, duracaoMs: t() };
}
