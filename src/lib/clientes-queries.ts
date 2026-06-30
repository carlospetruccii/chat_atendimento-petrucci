import { supabase } from "@/integrations/supabase/client";

export interface ClienteRow {
  id: string;
  nome: string | null;
  numero_whatsapp: string;
  created_at: string;
  total_atendimentos: number;
  ultimo_atendimento_at: string | null;
}

export interface ListClientesParams {
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface ListClientesResult {
  rows: ClienteRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Formata número E.164 brasileiro para "+55 (11) 99999-9999".
 * Para outros DDIs, devolve como está.
 */
export function formatTelefoneBR(numero: string): string {
  if (!numero) return "";
  if (!numero.startsWith("+55")) return numero;
  const digits = numero.slice(3);
  if (digits.length === 11) {
    return `+55 (${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `+55 (${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return numero;
}

export async function listClientesPaginado(
  params: ListClientesParams,
): Promise<ListClientesResult> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? 50;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from("clients")
    .select("id, nome, numero_whatsapp, created_at", { count: "exact" })
    .order("created_at", { ascending: false });

  const term = params.search?.trim();
  if (term) {
    // Escapa % e _ para busca segura
    const safe = term.replace(/[%_]/g, "\\$&");
    query = query.or(`nome.ilike.%${safe}%,numero_whatsapp.ilike.%${safe}%`);
  }

  const { data, error, count } = await query.range(from, to);
  if (error) throw error;

  const ids = (data ?? []).map((r) => r.id);
  const stats = new Map<string, { total: number; ultimo: string | null }>();

  if (ids.length > 0) {
    const { data: atends } = await supabase
      .from("atendimentos")
      .select("client_id, closed_at")
      .in("client_id", ids);
    for (const a of atends ?? []) {
      const cur = stats.get(a.client_id) ?? { total: 0, ultimo: null };
      cur.total += 1;
      if (a.closed_at && (!cur.ultimo || a.closed_at > cur.ultimo)) {
        cur.ultimo = a.closed_at;
      }
      stats.set(a.client_id, cur);
    }
  }

  const rows: ClienteRow[] = (data ?? []).map((r) => {
    const s = stats.get(r.id);
    return {
      id: r.id,
      nome: r.nome,
      numero_whatsapp: r.numero_whatsapp,
      created_at: r.created_at,
      total_atendimentos: s?.total ?? 0,
      ultimo_atendimento_at: s?.ultimo ?? null,
    };
  });

  return { rows, total: count ?? 0, page, pageSize };
}

export interface ClienteAutocompleteRow {
  id: string;
  nome: string | null;
  numero_whatsapp: string;
}

export async function searchClientesAutocomplete(
  term: string,
  limit = 10,
): Promise<ClienteAutocompleteRow[]> {
  const t = term.trim();
  if (t.length < 2) return [];
  const safe = t.replace(/[%_]/g, "\\$&");
  const { data, error } = await supabase
    .from("clients")
    .select("id, nome, numero_whatsapp")
    .or(`nome.ilike.%${safe}%,numero_whatsapp.ilike.%${safe}%`)
    .order("nome", { ascending: true, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export interface CadastrarClienteSingleResp {
  ok: boolean;
  criado: boolean;
  atualizado: boolean;
  cliente: { id: string; nome: string | null; numero_whatsapp: string };
  nome_anterior: string | null;
}

export async function cadastrarClienteSingle(
  nome: string,
  telefone: string,
): Promise<CadastrarClienteSingleResp> {
  const { data, error } = await supabase.functions.invoke("cadastrar-cliente", {
    body: { modo: "single", nome, telefone },
  });
  if (error) {
    // Tenta extrair body de erro
    const ctx = (error as { context?: Response }).context;
    if (ctx) {
      try {
        const j = await ctx.json();
        throw new Error(j?.detalhe || j?.erro || error.message);
      } catch (e) {
        if (e instanceof Error && e.message !== error.message) throw e;
      }
    }
    throw new Error(error.message);
  }
  return data as CadastrarClienteSingleResp;
}

export interface CadastrarClienteBatchResp {
  ok: boolean;
  total: number;
  criados: number;
  atualizados: number;
  erros: Array<{ linha: number; motivo: string; nome?: string; telefone?: string }>;
}

export async function cadastrarClientesBatch(
  linhas: Array<{ nome: string; telefone: string }>,
): Promise<CadastrarClienteBatchResp> {
  const { data, error } = await supabase.functions.invoke("cadastrar-cliente", {
    body: { modo: "csv_batch", linhas },
  });
  if (error) throw new Error(error.message);
  return data as CadastrarClienteBatchResp;
}
