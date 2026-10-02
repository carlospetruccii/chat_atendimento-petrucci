// Autorização de funções administrativas (importação, manutenção).
//
// Passa: superadmin ativo (JWT de usuário) OU uma chave de servidor do projeto
// — a service_role e as secret keys novas `sb_secret_...`, que o runtime expõe
// como JSON em SUPABASE_SECRET_KEYS. A secret key nova não é JWT, então com
// verify_jwt o gateway exige um JWT qualquer no Authorization e a chave vai no
// header `x-service-key`.

import type { getSupabaseAdmin } from "./supabase-client.ts";

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export function comparaConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function chavesDeServidor(): string[] {
  const chaves = [Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""];
  try {
    const mapa = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, unknown>;
    for (const v of Object.values(mapa)) if (typeof v === "string") chaves.push(v);
  } catch {
    // formato inesperado: fica só com a service_role
  }
  return chaves.filter((c) => c !== "");
}

export async function ehOperadorOuSuperadmin(req: Request, supabase: Supabase): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const chaveExtra = req.headers.get("x-service-key") ?? "";
  for (const chave of chavesDeServidor()) {
    if (comparaConstante(jwt, chave) || comparaConstante(chaveExtra, chave)) return true;
  }
  if (!jwt) return false;

  const { data: userRes, error } = await supabase.auth.getUser(jwt);
  if (error || !userRes?.user) return false;
  const { data: quem } = await supabase
    .from("users")
    .select("is_superadmin, ativo")
    .eq("id", userRes.user.id)
    .maybeSingle();
  return quem?.is_superadmin === true && quem?.ativo === true;
}
