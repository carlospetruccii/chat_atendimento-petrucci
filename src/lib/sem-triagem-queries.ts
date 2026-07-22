import { supabase } from "@/integrations/supabase/client";
import { normalizarE164, formatarNumero } from "./phone";

export { normalizarE164, formatarNumero };

// ---------------------------------------------------------------------------
// Lista "Sem Triagem" — números que NÃO recebem NENHUMA triagem. Separada da
// Lista de Sessões: aqui a primeira mensagem já abre o atendimento concluído,
// direto na fila geral de Pendentes, sem nenhuma mensagem do bot.
// ---------------------------------------------------------------------------

export interface SemTriagemRow {
  id: string;
  numero_whatsapp: string;
  nome: string | null;
  ativo: boolean;
  created_at: string;
}

export async function fetchSemTriagem(): Promise<SemTriagemRow[]> {
  const { data, error } = await supabase
    .from("numeros_sem_triagem")
    .select("id, numero_whatsapp, nome, ativo, created_at")
    .order("nome", { ascending: true, nullsFirst: false })
    .order("numero_whatsapp", { ascending: true });
  if (error) throw error;
  return (data ?? []) as SemTriagemRow[];
}

export async function addSemTriagem(input: {
  numero: string;
  nome?: string | null;
}): Promise<void> {
  const e164 = normalizarE164(input.numero);
  if (!e164) {
    throw new Error("Número inválido. Use DDD + número (ex.: 11 91234-5678).");
  }
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase.from("numeros_sem_triagem").insert({
    numero_whatsapp: e164,
    nome: input.nome?.trim() || null,
    created_by: auth.user?.id ?? null,
  });
  if (error) {
    if (error.code === "23505") throw new Error("Esse número já está na lista.");
    throw error;
  }
}

export async function removeSemTriagem(id: string): Promise<void> {
  const { error } = await supabase.from("numeros_sem_triagem").delete().eq("id", id);
  if (error) throw error;
}

export async function setSemTriagemAtivo(id: string, ativo: boolean): Promise<void> {
  const { error } = await supabase.from("numeros_sem_triagem").update({ ativo }).eq("id", id);
  if (error) throw error;
}
