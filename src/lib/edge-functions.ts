// Utilitários das chamadas a Edge Functions que mandam arquivo ou devolvem um
// código de erro no corpo. Moravam dentro de grupos-queries.ts; saíram daqui
// quando o Docs (docs-queries.ts) passou a precisar exatamente dos mesmos.

/** Blob → base64 sem o prefixo data:. Em blocos para não estourar a pilha. */
export async function blobParaBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/**
 * Lê o corpo JSON de uma resposta não-2xx de Edge Function. O supabase-js
 * transforma 4xx/5xx num `error` genérico ("non-2xx status code"); o motivo
 * real está no corpo, em `error.context` (um Response).
 */
export async function corpoDoErro(error: unknown): Promise<Record<string, unknown> | undefined> {
  const resposta = (error as { context?: unknown })?.context;
  if (!(resposta instanceof Response)) return undefined;
  try {
    const corpo = (await resposta.clone().json()) as unknown;
    return corpo && typeof corpo === "object" ? (corpo as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Lê o campo `erro` do corpo de uma resposta não-2xx de Edge Function. */
export async function codigoDoErro(error: unknown): Promise<string | undefined> {
  const corpo = await corpoDoErro(error);
  return typeof corpo?.erro === "string" ? corpo.erro : undefined;
}
