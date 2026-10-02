// Decisões puras sobre foto de perfil (pessoa ou grupo) vinda da uazapi.
//
// A uazapi devolve links do CDN do WhatsApp, que EXPIRAM. Por isso guardamos
// quando a foto foi conferida e renovamos depois de FOTO_TTL_MS.

/** Depois disso a foto é buscada de novo (o link do WhatsApp expira). */
export const FOTO_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** Só https: a URL vai parar num <img src> do painel. */
export function urlSegura(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return /^https:\/\/[^\s]+$/i.test(t) ? t : null;
}

/**
 * Foto de um objeto Chat/Grupo da uazapi. Prefere a miniatura (`imagePreview`),
 * que é a que cabe num avatar de lista.
 */
export function fotoDoChat(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const campos = [
    "imagePreview",
    "image",
    "image_preview_url",
    "image_url",
    "imgUrl",
    "profilePicUrl",
    "wa_profilePicUrl",
  ];
  for (const campo of campos) {
    const url = urlSegura(o[campo]);
    if (url) return url;
  }
  return null;
}

/** Depois de uma falha na uazapi, tenta de novo só depois disso. */
export const ESPERA_APOS_FALHA_MS = 60 * 60 * 1000;

/**
 * `foto_atualizada_em` a gravar quando a consulta falhou: um instante que faz a
 * foto vencer de novo em ESPERA_APOS_FALHA_MS, e não na próxima mensagem.
 */
export function instanteDeNovaTentativa(agoraMs: number): string {
  return new Date(agoraMs - FOTO_TTL_MS + ESPERA_APOS_FALHA_MS).toISOString();
}

/** A foto precisa ser conferida de novo? (nunca conferida ou passou do TTL). */
export function fotoVencida(atualizadaEmIso: string | null | undefined, agoraMs: number): boolean {
  if (!atualizadaEmIso) return true;
  const t = Date.parse(atualizadaEmIso);
  if (!Number.isFinite(t)) return true;
  return agoraMs - t > FOTO_TTL_MS;
}

/**
 * Lê a foto de um grupo na resposta da /group/info (Group cru ou dentro de
 * `group`/`data`). `semFoto` = a uazapi já conferiu no WhatsApp e o grupo não
 * tem foto (`picture_empty_at`) — não adianta pedir atualização remota.
 */
export function lerFotoGrupo(resp: unknown): { url: string | null; semFoto: boolean } {
  const env = (resp && typeof resp === "object" ? resp : {}) as Record<string, unknown>;
  const aninhado = env.group ?? env.Group ?? env.data;
  const g = (aninhado && typeof aninhado === "object" ? aninhado : env) as Record<string, unknown>;
  const url = fotoDoChat(g);
  return { url, semFoto: !url && Boolean(g.picture_empty_at) };
}
