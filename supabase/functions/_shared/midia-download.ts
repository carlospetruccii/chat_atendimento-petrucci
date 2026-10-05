// Download dos bytes de uma mídia RECEBIDA do WhatsApp.
//
// Extraído do webhook para ser usado também pelas mensagens de grupo: é a parte
// mais frágil do fluxo de mídia (a URL que o WhatsApp entrega é criptografada
// .enc e não serve direto), então tem que existir em UM lugar só. Duplicar as
// três tentativas de fallback significaria consertar bug de mídia duas vezes.

import { baixarMidiaMensagem, type Instancia } from "./uazapi-client.ts";

/**
 * Mídia obtida, em um de dois modos.
 *
 * `bytes` é o caminho normal: arquivo pequeno, cabe na memória, sobe de uma vez.
 * `stream` é para arquivo grande — nunca carregamos ele inteiro, os bytes vão
 * direto da origem para o Storage, bloco a bloco (ver midia-storage.ts). O
 * segundo só existe quando a origem DECLARA o tamanho, que é o que o upload em
 * blocos exige saber de antemão.
 */
export type MidiaObtida =
  | { modo: "bytes"; buf: Uint8Array; contentType: string | null; fonte: string }
  | {
    modo: "stream";
    corpo: ReadableStream<Uint8Array>;
    tamanho: number;
    contentType: string | null;
    fonte: string;
  };

/** @deprecated nome antigo, mantido para não quebrar import de fora. */
export interface BytesMidia {
  buf: Uint8Array;
  contentType: string | null;
  fonte: string;
}

/**
 * Teto de tamanho: o MESMO teto do Storage do projeto (50 MiB). Passar disso
 * não adianta — o upload seria recusado de qualquer jeito.
 *
 * Era 16 MB (o limite de ENVIO da uazapi), o que não tem nada a ver com o que o
 * cliente pode MANDAR: um .rar de documentos passa fácil disso e a mídia caía
 * como indisponível. Sem o teto, porém, uma URL hostil serviria um stream
 * infinito e derrubaria a função por memória.
 */
// No Almore o teto é 300 MB porque lá o limite global do Storage foi aumentado.
// Este projeto está no plano Free (teto de 50 MiB por arquivo, sem como subir).
// Se mudar de plano e aumentar o limite, suba este número junto.
export const MAX_BYTES = 50 * 1024 * 1024;

/**
 * Acima disto o arquivo vai em fluxo, sem passar pela memória. Abaixo, o
 * caminho simples de sempre: uma requisição só, sem a dança de blocos do tus.
 * O corte é folgado perto dos 256 MB da função — o que pesa não é este buffer,
 * é o arquivo inteiro.
 */
const LIMITE_BUFFER = 24 * 1024 * 1024;

/**
 * Teto da resposta do /message/download COM base64. É um caminho que carrega o
 * arquivo inteiro numa string JSON (infla ~33%, e string é UTF-16 na memória):
 * foi exatamente assim que o isolate morreu com "Memory limit exceeded". Fica
 * baixo de propósito — arquivo grande tem que vir pela fileURL, em stream.
 */
const MAX_BYTES_BASE64 = 24 * 1024 * 1024;

/** Arquivo maior que o teto: erro próprio porque a UI trata diferente (não
 *  adianta oferecer "tentar de novo" — vai dar o mesmo tamanho). */
export class MidiaGrandeDemais extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(
      `arquivo de ${(bytes / 1048576).toFixed(1)} MB, acima do limite de ${
        Math.round(MAX_BYTES / 1048576)
      } MB`,
    );
    this.name = "MidiaGrandeDemais";
    this.bytes = bytes;
  }
}

// SSRF: a URL da terceira tentativa vem do PAYLOAD do webhook (`fileURL`), que é
// entrada externa. Sem esta checagem, o webhook viraria um "busque esta URL por
// mim" rodando dentro da infraestrutura — inclusive contra endereços internos
// (metadata de cloud, localhost, rede privada).
function destinoPermitido(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || host.endsWith(".internal")) return false;
  if (host.endsWith(".local") || host.endsWith(".localhost")) return false;
  // IPv4 privado / loopback / link-local (metadata de cloud fica em 169.254).
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^0\./.test(host)) return false;
  // IPv6 loopback / link-local / unique-local.
  if (host.startsWith("[fe80:") || host.startsWith("[fc") || host.startsWith("[fd")) return false;
  return true;
}

// Teto de tempo para puxar os bytes de uma URL. Sem isso, um CDN lento deixa a
// tarefa de background pendurada até a Edge Function ser morta pelo runtime.
// Cobre a leitura do corpo inteiro, então tem que caber um arquivo grande: a
// 1 MB/s, 250 MB levam mais de quatro minutos.
const FETCH_TIMEOUT_MS = 300_000;

/**
 * Lê o corpo em pedaços, parando assim que passa do teto.
 *
 * `resp.arrayBuffer()` não serve: ele bufferiza TUDO antes de qualquer
 * checagem, então um arquivo grande derruba a função por memória mesmo com
 * um teto declarado logo depois. Quando o servidor informa content-length, o
 * buffer já nasce do tamanho exato — sem a cópia extra da concatenação.
 */
async function lerCorpoComTeto(resp: Response, max: number): Promise<Uint8Array> {
  const declarado = Number(resp.headers.get("content-length") ?? "0");
  if (declarado > max) {
    await resp.body?.cancel();
    throw new MidiaGrandeDemais(declarado);
  }
  if (!resp.body) return new Uint8Array(0);

  const reader = resp.body.getReader();
  const destino = declarado > 0 ? new Uint8Array(declarado) : null;
  const partes: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max || (destino !== null && total > destino.byteLength)) {
      await reader.cancel();
      throw new MidiaGrandeDemais(total);
    }
    if (destino) destino.set(value, total - value.byteLength);
    else partes.push(value);
  }

  if (destino) return total === destino.byteLength ? destino : destino.subarray(0, total);

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const parte of partes) {
    buf.set(parte, offset);
    offset += parte.byteLength;
  }
  return buf;
}

/**
 * Abre a URL e decide como a mídia vai ser entregue: em bytes (pequena) ou em
 * fluxo (grande). Devolve null quando a URL não serve; estourar o teto NÃO é
 * "não serve" — propaga, para a mensagem final dizer o tamanho.
 */
export async function abrirMidia(alvo: string, fonte: string): Promise<MidiaObtida | null> {
  let url: URL;
  try {
    url = new URL(alvo);
  } catch {
    return null;
  }
  if (!destinoPermitido(url)) return null;

  // redirect: "error" fecha o desvio para endereço interno via 302 (a checagem
  // acima só vê a URL inicial).
  const resp = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    await resp.body?.cancel();
    return null;
  }

  const contentType = resp.headers.get("content-type");
  const declarado = Number(resp.headers.get("content-length") ?? "0");
  if (declarado > MAX_BYTES) {
    await resp.body?.cancel();
    throw new MidiaGrandeDemais(declarado);
  }

  if (declarado > LIMITE_BUFFER && resp.body) {
    return { modo: "stream", corpo: resp.body, tamanho: declarado, contentType, fonte };
  }

  const buf = await lerCorpoComTeto(resp, MAX_BYTES);
  if (buf.byteLength === 0) return null;
  return { modo: "bytes", buf, contentType, fonte };
}

function base64ParaBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

/** Dependências injetáveis — existem para o teste, a produção usa o default. */
export interface DepsBytesMidia {
  baixar: typeof baixarMidiaMensagem;
  abrir: typeof abrirMidia;
}

const DEPS_PADRAO: DepsBytesMidia = { baixar: baixarMidiaMensagem, abrir: abrirMidia };

function motivoDe(err: unknown): string {
  if (err instanceof Error) {
    // AbortSignal.timeout / AbortController → nome genérico, pouco útil no log.
    if (err.name === "TimeoutError" || err.name === "AbortError") return "tempo esgotado";
    return err.message.slice(0, 80);
  }
  return "falha desconhecida";
}

/**
 * Obtém a mídia, em ordem de custo (a mais barata primeiro):
 *   1. POST /message/download SEM base64 → `fileURL` já descriptografada pela
 *      uazapi; a resposta é pequena e os bytes vêm num GET comum;
 *   2. o mesmo endpoint COM return_base64 (resposta infla ~33% e a uazapi só
 *      responde no fim — é o que estourava o timeout em anexo grande, ex .rar);
 *   3. a URL que veio no webhook — só se for http(s) de verdade.
 *
 * Cada etapa falha isolada: uma exceção na 1ª não pode cancelar as outras duas,
 * senão um timeout da uazapi vira "mídia indisponível" para sempre.
 *
 * `instancia`: o número que RECEBEU a mensagem — o /message/download só acha a
 * mensagem na instância dona dela.
 */
export async function obterMidia(
  urlOriginal: string | null,
  uazapiMessageId: string,
  deps: DepsBytesMidia = DEPS_PADRAO,
  instancia?: Instancia,
): Promise<MidiaObtida> {
  const motivos: string[] = [];

  const comMime = (m: MidiaObtida, mime?: string): MidiaObtida =>
    m.contentType ? m : { ...m, contentType: mime ?? null };

  // 1) fileURL da uazapi (sem base64).
  try {
    const res = await deps.baixar(uazapiMessageId, instancia ? { instancia } : undefined);
    if (res.url) {
      const r = await deps.abrir(res.url, "message_download_url");
      if (r) return comMime(r, res.mimetype);
      motivos.push("fileURL não entregou bytes");
    } else if (res.base64) {
      // Algumas respostas já vêm com o conteúdo inline mesmo sem pedir.
      const buf = base64ParaBytes(res.base64);
      if (buf.byteLength > 0) {
        return {
          modo: "bytes",
          buf,
          contentType: res.mimetype ?? null,
          fonte: "message_download_base64",
        };
      }
      motivos.push("base64 vazio");
    } else {
      motivos.push("resposta sem fileURL");
    }
  } catch (err) {
    // Grande demais é veredito final: as outras tentativas trariam o MESMO
    // arquivo, e o base64 (teto ainda menor) só derrubaria a função.
    if (err instanceof MidiaGrandeDemais) throw err;
    motivos.push(`fileURL: ${motivoDe(err)}`);
  }

  // 2) mesmo endpoint, agora pedindo o conteúdo inline.
  try {
    const res = await deps.baixar(uazapiMessageId, {
      retornarBase64: true,
      maxBytesResposta: MAX_BYTES_BASE64,
      ...(instancia ? { instancia } : {}),
    });
    if (res.base64) {
      const buf = base64ParaBytes(res.base64);
      if (buf.byteLength > 0) {
        return {
          modo: "bytes",
          buf,
          contentType: res.mimetype ?? null,
          fonte: "message_download_base64",
        };
      }
    }
    if (res.url) {
      const r = await deps.abrir(res.url, "message_download_url");
      if (r) return comMime(r, res.mimetype);
    }
    motivos.push("base64 vazio");
  } catch (err) {
    if (err instanceof MidiaGrandeDemais) throw err;
    motivos.push(`base64: ${motivoDe(err)}`);
  }

  // 3) URL do payload do webhook.
  if (urlOriginal) {
    try {
      const r = await deps.abrir(urlOriginal, "url_original");
      if (r) return r;
      motivos.push("url original recusada");
    } catch (err) {
      if (err instanceof MidiaGrandeDemais) throw err;
      motivos.push(`url original: ${motivoDe(err)}`);
    }
  }

  throw new Error(`não foi possível obter os bytes da mídia (${motivos.join("; ")})`);
}

// Content-Type de arquivo recebido de terceiro: sem whitelist, um `text/html`
// subiria para o bucket e seria SERVIDO no domínio do projeto pela URL assinada.
// Tipo desconhecido vira binário inerte (o download continua funcionando).
const MIMES_PERMITIDOS = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/webm",
  "application/pdf",
  // Compactados — inertes no navegador, e é o que o cliente mais manda.
  "application/zip",
  "application/x-zip-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/x-rar",
  "application/x-compressed",
  "application/x-7z-compressed",
]);

/** Content-Type seguro para subir ao bucket; desconhecido vira octet-stream. */
export function contentTypeSeguro(bruto: string | null | undefined): string {
  const base = (bruto ?? "").split(";")[0].trim().toLowerCase();
  return MIMES_PERMITIDOS.has(base) ? base : "application/octet-stream";
}

/** Extensão de arquivo a partir do mime type; `fallback` quando não reconhece. */
export function deduzirExtensao(mime: string | null | undefined, fallback: string): string {
  if (!mime) return fallback;
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "video/mp4": "mp4",
    "application/pdf": "pdf",
    // Compactados: contador manda .rar/.zip o tempo todo. Sem o mapa, o arquivo
    // ia para o bucket como ".bin" e o navegador baixava com o nome errado.
    "application/zip": "zip",
    "application/x-zip-compressed": "zip",
    "application/vnd.rar": "rar",
    "application/x-rar-compressed": "rar",
    "application/x-rar": "rar",
    "application/x-compressed": "rar",
    "application/x-7z-compressed": "7z",
  };
  return map[mime.split(";")[0].trim().toLowerCase()] ?? fallback;
}
