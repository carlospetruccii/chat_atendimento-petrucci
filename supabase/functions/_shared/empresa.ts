// Resolve a empresa do usuário que chamou a Edge Function.
//
// SEGURANÇA — por que NÃO há fallback aqui:
// A tentação é, quando o usuário não tem linha em `company_members`, cair para
// "a empresa mais antiga" (é o que o `criar-colaborador` faz no bring-up). Num
// sistema single-tenant isso significa: **qualquer conta autenticada do projeto
// vira membro da empresa**, mesmo sem nenhum vínculo — e passaria a poder
// enviar mensagem de WhatsApp pelo número da empresa. Como o `is_member_of` do
// banco hoje é no-op (`auth_enforcement_enabled = false`), esta função é o
// controle de acesso REAL das funções de grupo; um fallback aqui anularia ele.
//
// Então: sem vínculo ativo → null → 403. Em 27/07/2026 os 5 usuários reais da
// empresa têm vínculo ativo em `company_members`, então isso não bloqueia
// ninguém legítimo.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export interface MembroResolvido {
  companyId: string;
  userId: string;
}

/**
 * Exige vínculo ativo em `company_members` E `users.ativo = true`.
 * Retorna null quando o chamador não pode agir em nome de nenhuma empresa —
 * o chamador deve responder 403.
 *
 * A checagem de `users.ativo` importa porque grupo não tem atribuição: no chat
 * individual, desligar um colaborador já corta o envio (o trigger libera o
 * `assigned_to` e as funções de envio exigem ser o responsável). Em grupo não
 * existe responsável, então sem esta checagem um ex-colaborador com JWT ainda
 * válido continuaria enviando mensagem em nome da empresa.
 */
export async function exigirMembroAtivo(
  admin: SupabaseClient,
  userId: string,
): Promise<MembroResolvido | null> {
  const [membroRes, userRes] = await Promise.all([
    admin
      .from("company_members")
      .select("company_id")
      .eq("user_id", userId)
      .eq("ativo", true)
      .maybeSingle(),
    admin.from("users").select("ativo").eq("id", userId).maybeSingle(),
  ]);

  const companyId = membroRes.data?.company_id as string | undefined;
  if (!companyId) return null;
  if (userRes.data?.ativo !== true) return null;

  return { companyId, userId };
}
