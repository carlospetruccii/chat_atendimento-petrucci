// Download dos bytes de uma mídia RECEBIDA do WhatsApp.
//
// Extraído do webhook para ser usado também pelas mensagens de grupo: é a parte
// mais frágil do fluxo de mídia (a URL que o WhatsApp entrega é criptografada
// .enc e não serve direto), então tem que existir em UM lugar só. Duplicar as
// três tentativas de fallback significaria consertar bug de mídia duas vezes.

import { baixarMidiaMensagem } from "./uazapi-client.ts";

export interface BytesMidia {
  buf: Uint8Array;
  contentType: string | null;
  /** De onde os bytes vieram — vai para o log, ajuda a diagnosticar. */
  fonte: string;
}

// Teto de tamanho: o mesmo limite de anexo da uazapi (16 MB). Sem isso, uma URL
// hostil poderia servir um stream gigante e estourar a memória da função.
const MAX_BYTES = 16 * 1024 * 1024;

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

async function buscarComLimite(alvo: string): Promise<{
  buf: Uint8Array;
  contentType: string | null;
} | null> {
  let url: URL;
  try {
    url = new URL(alvo);
  } catch {
    return null;
  }
  if (!destinoPermitido(url)) return null;

  // redirect: "error" fecha o desvio para endereço interno via 302 (a checagem
  // acima só vê a URL inicial).
  const resp = await fetch(url, { redirect: "error" });
  if (!resp.ok) return null;

  const declarado = Number(resp.headers.get("content-length") ?? "0");
  if (declarado > MAX_BYTES) return null;

  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;
  return { buf, contentType: resp.headers.get("content-type") };
}

/**
 * Obtém os bytes da mídia, em ordem de confiabilidade:
 *   1. POST /message/download com return_base64 (bytes já decodificados);
 *   2. a fileURL que esse mesmo endpoint devolve (já decodificada pela uazapi);
 *   3. a URL que veio no webhook — só se for http(s) de verdade.
 */
export async function obterBytesMidia(
  urlOriginal: string | null,
  uazapiMessageId: string,
): Promise<BytesMidia> {
  try {
    const res = await baixarMidiaMensagem(uazapiMessageId);
    if (res.base64) {
      const bin = atob(res.base64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      if (buf.byteLength > 0) {
        return { buf, contentType: res.mimetype ?? null, fonte: "message_download_base64" };
      }
    }
    if (res.url) {
      const r = await buscarComLimite(res.url);
      if (r) {
        return {
          buf: r.buf,
          contentType: r.contentType ?? res.mimetype ?? null,
          fonte: "message_download_url",
        };
      }
    }
  } catch {
    // cai para a tentativa direta abaixo
  }

  if (urlOriginal) {
    const r = await buscarComLimite(urlOriginal);
    if (r) {
      return { buf: r.buf, contentType: r.contentType, fonte: "url_original" };
    }
  }
  throw new Error("não foi possível obter os bytes da mídia (/message/download)");
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
  };
  return map[mime.split(";")[0].trim().toLowerCase()] ?? fallback;
}
