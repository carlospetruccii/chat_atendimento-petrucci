// Conversa do Docs de um cliente: acha ou cria (1 por cliente no número
// financeiro). Usado pelo webhook e pela importação do histórico.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { log } from "./logger.ts";

export async function conversaDocsDoCliente(
  supabase: SupabaseClient,
  companyId: string,
  clientId: string,
  funcao: string,
): Promise<string | null> {
  const { error: errIns } = await supabase
    .from("docs_conversas")
    .upsert(
      { company_id: companyId, client_id: clientId },
      { onConflict: "company_id,client_id", ignoreDuplicates: true },
    );
  if (errIns) {
    log({ funcao, evento: "conversa_upsert_erro", status: "erro", erro_msg: errIns.message });
  }
  const { data } = await supabase
    .from("docs_conversas")
    .select("id")
    .eq("company_id", companyId)
    .eq("client_id", clientId)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}
