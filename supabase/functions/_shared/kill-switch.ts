// Kill switch do bot: lê system_config.bot_ativo.
// Cache em memória de 60s para não martelar o banco a cada webhook.
//
// Convenção: o valor é armazenado em system_config sob a chave 'bot_ativo'
// como booleano (campo `valor` jsonb). Qualquer valor diferente de `true`
// é tratado como bot DESLIGADO (fail-safe: na dúvida, não automatiza).

import { getSupabaseAdmin } from "./supabase-client.ts";

const TTL_MS = 60_000;

interface CacheEntry {
  valor: boolean;
  expira_em: number;
}

let cache: CacheEntry | null = null;

export async function botEstaAtivo(): Promise<boolean> {
  const agora = Date.now();
  if (cache && cache.expira_em > agora) {
    return cache.valor;
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("system_config")
    .select("valor")
    .eq("chave", "bot_ativo")
    .maybeSingle();

  // Fail-safe: erro de leitura ou ausência → considera DESLIGADO.
  let valor = false;
  if (!error && data) {
    const v = (data as { valor: unknown }).valor;
    valor = v === true || v === "true";
  }

  cache = { valor, expira_em: agora + TTL_MS };
  return valor;
}

// Limpa o cache (útil para testes ou após toggle manual conhecido).
export function invalidarCacheBotAtivo(): void {
  cache = null;
  cacheAtivadoEm = null;
}

// Cache separado para bot_ativado_em (timestamp ISO da última religação).
interface CacheAtivadoEm {
  valor: string | null;
  expira_em: number;
}
let cacheAtivadoEm: CacheAtivadoEm | null = null;

export async function getBotAtivadoEm(): Promise<string | null> {
  const agora = Date.now();
  if (cacheAtivadoEm && cacheAtivadoEm.expira_em > agora) {
    return cacheAtivadoEm.valor;
  }
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("system_config")
    .select("valor")
    .eq("chave", "bot_ativado_em")
    .maybeSingle();
  let valor: string | null = null;
  if (!error && data) {
    const v = (data as { valor: unknown }).valor;
    valor = typeof v === "string" && v.length > 0 ? v : null;
  }
  cacheAtivadoEm = { valor, expira_em: agora + TTL_MS };
  return valor;
}
