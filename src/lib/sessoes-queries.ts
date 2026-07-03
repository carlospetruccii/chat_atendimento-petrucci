import { supabase } from "@/integrations/supabase/client";

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

/**
 * Normaliza um número digitado para E.164 (+55...). Aceita com/sem máscara.
 * Sem código de país, assume Brasil (55) para 10–11 dígitos (DDD + número).
 * Retorna null se não formar um E.164 válido (mesma regra da CHECK do banco).
 */
export function normalizarE164(input: string): string | null {
  let d = (input ?? "").replace(/\D/g, "");
  d = d.replace(/^0+/, "");
  if (!d) return null;
  if (d.length === 10 || d.length === 11) d = "55" + d;
  const e164 = "+" + d;
  return /^\+[1-9][0-9]{7,14}$/.test(e164) ? e164 : null;
}

/** Formata E.164 para exibição: +55 (11) 91234-5678 quando for número BR. */
export function formatarNumero(e164: string): string {
  const br = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
  if (br) return `+55 (${br[1]}) ${br[2]}-${br[3]}`;
  return e164;
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
