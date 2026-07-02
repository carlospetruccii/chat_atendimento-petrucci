import { supabase } from "@/integrations/supabase/client";

// ---------------------------------------------------------------------------
// Conexão / sincronização com a conta Google (via Edge Function google-contacts)
// ---------------------------------------------------------------------------

export interface GoogleStatus {
  ok: boolean;
  configured: boolean;
  connected: boolean;
  email: string | null;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  contacts_count: number;
}

export async function googleStatus(): Promise<GoogleStatus> {
  const { data, error } = await supabase.functions.invoke("google-contacts", {
    body: { action: "status" },
  });
  if (error) throw error;
  return data as GoogleStatus;
}

/** Pede a URL de consentimento do Google; o app redireciona o navegador para ela. */
export async function googleAuthUrl(redirectBack: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke("google-contacts", {
    body: { action: "auth_url", redirect_back: redirectBack },
  });
  if (error) throw error;
  const resp = data as { ok: boolean; url?: string; detalhe?: string };
  if (!resp.ok || !resp.url) throw new Error(resp.detalhe ?? "Não foi possível iniciar a conexão.");
  return resp.url;
}

export interface SyncResult {
  ok: boolean;
  total?: number;
  atualizados?: number;
  removidos?: number;
  erro?: string;
  detalhe?: string;
}

export async function googleSync(): Promise<SyncResult> {
  const { data, error } = await supabase.functions.invoke("google-contacts", {
    body: { action: "sync" },
  });
  if (error) throw error;
  return data as SyncResult;
}

export async function googleDisconnect(): Promise<void> {
  const { data, error } = await supabase.functions.invoke("google-contacts", {
    body: { action: "disconnect" },
  });
  if (error) throw error;
  const resp = data as { ok: boolean; detalhe?: string };
  if (!resp.ok) throw new Error(resp.detalhe ?? "Falha ao desconectar.");
}

// ---------------------------------------------------------------------------
// Leitura dos contatos (tabela contatos)
// ---------------------------------------------------------------------------

export interface Contato {
  id: string;
  nome: string | null;
  numero_whatsapp: string | null;
  numero_raw: string | null;
  emails: string[];
}

export interface ListContatosResult {
  rows: Contato[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listContatos(params: {
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<ListContatosResult> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? 50;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from("contatos")
    .select("id, nome, numero_whatsapp, numero_raw, emails", { count: "exact" })
    .order("nome", { ascending: true, nullsFirst: false });

  const term = params.search?.trim();
  if (term) {
    const safe = term.replace(/[%_]/g, "\\$&");
    query = query.or(
      `nome.ilike.%${safe}%,numero_whatsapp.ilike.%${safe}%,numero_raw.ilike.%${safe}%`,
    );
  }

  const { data, error, count } = await query.range(from, to);
  if (error) throw error;

  const rows: Contato[] = (data ?? []).map((r) => ({
    id: r.id,
    nome: r.nome,
    numero_whatsapp: r.numero_whatsapp,
    numero_raw: r.numero_raw,
    emails: Array.isArray(r.emails) ? (r.emails as string[]) : [],
  }));

  return { rows, total: count ?? 0, page, pageSize };
}

// ---------------------------------------------------------------------------
// Resolução de nome com precedência: contato Google > nome público WhatsApp > número
// ---------------------------------------------------------------------------

/**
 * Dado um conjunto de números (E.164, como em clients.numero_whatsapp), devolve
 * um mapa número → nome salvo nos Contatos do Google. Usado no Inbox para que o
 * nome do contato tenha prioridade sobre o nome público do WhatsApp.
 *
 * É aditivo e à prova de falha: se a consulta der erro, devolve um mapa vazio
 * (o Inbox segue mostrando o nome atual, sem quebrar).
 */
export async function fetchContatoNamesByNumbers(
  numeros: string[],
): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  const unicos = Array.from(new Set(numeros.filter(Boolean)));
  if (unicos.length === 0) return mapa;
  try {
    const { data, error } = await supabase
      .from("contatos")
      .select("numero_whatsapp, nome")
      .in("numero_whatsapp", unicos)
      .not("nome", "is", null);
    if (error) return mapa;
    for (const row of data ?? []) {
      const num = row.numero_whatsapp;
      const nome = row.nome?.trim();
      if (num && nome && !mapa.has(num)) mapa.set(num, nome);
    }
  } catch {
    // silencioso: nome do contato é um "plus", nunca deve derrubar o Inbox.
  }
  return mapa;
}
