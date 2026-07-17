import { supabase } from "@/integrations/supabase/client";
import { normalizarE164, formatarNumero } from "./phone";

// Reexporta os utilitários de telefone para manter os imports existentes.
export { normalizarE164, formatarNumero };

// ---------------------------------------------------------------------------
// Lista de Sessões — números liberados que rodam o fluxo interno (escolhem
// departamento e depois o colaborador, em vez da triagem normal de cliente).
// ---------------------------------------------------------------------------

export interface SessaoRow {
  id: string;
  numero_whatsapp: string;
  nome: string | null;
  ativo: boolean;
  created_at: string;
}

export async function fetchSessoes(): Promise<SessaoRow[]> {
  const { data, error } = await supabase
    .from("sessoes_triagem")
    .select("id, numero_whatsapp, nome, ativo, created_at")
    .order("nome", { ascending: true, nullsFirst: false })
    .order("numero_whatsapp", { ascending: true });
  if (error) throw error;
  return (data ?? []) as SessaoRow[];
}

export async function addSessao(input: { numero: string; nome?: string | null }): Promise<void> {
  const e164 = normalizarE164(input.numero);
  if (!e164) {
    throw new Error("Número inválido. Use DDD + número (ex.: 11 91234-5678).");
  }
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase.from("sessoes_triagem").insert({
    numero_whatsapp: e164,
    nome: input.nome?.trim() || null,
    created_by: auth.user?.id ?? null,
  });
  if (error) {
    if (error.code === "23505") throw new Error("Esse número já está na lista.");
    throw error;
  }
}

export async function removeSessao(id: string): Promise<void> {
  const { error } = await supabase.from("sessoes_triagem").delete().eq("id", id);
  if (error) throw error;
}

export async function setSessaoAtivo(id: string, ativo: boolean): Promise<void> {
  const { error } = await supabase.from("sessoes_triagem").update({ ativo }).eq("id", id);
  if (error) throw error;
}
