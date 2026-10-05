// Controle de acesso das Edge Functions da aba Docs (número financeiro).
//
// Duas camadas, as duas obrigatórias:
//   1. vínculo ativo na empresa (exigirMembroAtivo — o `is_member_of` do banco
//      é no-op enquanto a trava multi-empresa está desligada);
//   2. acesso ao Docs: admin ou permissão `docs_acesso`. A regra mora numa
//      função só do banco (`usuario_pode_acessar_docs`), a mesma que a RLS usa,
//      para a tela e o servidor nunca discordarem.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { exigirMembroAtivo, type MembroResolvido } from "./empresa.ts";

export interface MembroDocs extends MembroResolvido {
  isSuperadmin: boolean;
}

/** null → o chamador deve responder 403. */
export async function exigirAcessoDocs(
  admin: SupabaseClient,
  userId: string,
): Promise<MembroDocs | null> {
  const membro = await exigirMembroAtivo(admin, userId);
  if (!membro) return null;

  const [acessoRes, userRes] = await Promise.all([
    admin.rpc("usuario_pode_acessar_docs", { p_user_id: userId }),
    admin.from("users").select("is_superadmin").eq("id", userId).maybeSingle(),
  ]);
  if (acessoRes.error || acessoRes.data !== true) return null;

  return { ...membro, isSuperadmin: userRes.data?.is_superadmin === true };
}

/** Lê o JWT do header Authorization e resolve o usuário. null → 401. */
export async function usuarioDoJwt(
  admin: SupabaseClient,
  req: Request,
): Promise<string | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!jwt) return null;
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) return null;
  return data.user.id;
}
