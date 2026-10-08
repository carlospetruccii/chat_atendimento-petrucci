import { supabase } from "@/integrations/supabase/client";
import {
  initialsOf,
  FALLBACK_DEPT_COR,
  notificarRepasse,
  type AtendimentoStatus,
} from "./inbox-queries";

export { initialsOf, FALLBACK_DEPT_COR };

export interface PendenteRow {
  id: string;
  clientId: string;
  clientNome: string;
  clientNumero: string;
  initials: string;
  status: AtendimentoStatus;
  departmentId: string | null;
  departmentNome: string | null;
  departmentCor: string;
  waitingMin: number;
  releasedByTimeout: boolean;
  preview: string;
  createdAt: string;
}

export interface DeptOption {
  id: string;
  nome: string;
  cor: string;
}

export interface CollaboratorOption {
  id: string;
  nome: string;
  initials: string;
  departmentId: string | null;
  departmentNome: string;
}

function previewFromMsg(content: string | null, tipo: string | null): string {
  if (content && content.trim()) return content;
  switch (tipo) {
    case "imagem": return "📷 Imagem";
    case "audio": return "🎤 Áudio";
    case "video": return "🎥 Vídeo";
    case "documento": return "📎 Documento";
    case "localizacao": return "📍 Localização";
    case "contato": return "👤 Contato";
    default: return "";
  }
}

export async function fetchPendentes(): Promise<PendenteRow[]> {
  const { data, error } = await supabase
    .from("atendimentos")
    .select(`
      id, status, current_department_id, created_at, last_message_at,
      triagem_started_at, transferred_count, escalated_from_user_id,
      client:clients!atendimentos_client_id_fkey!inner ( id, nome, numero_whatsapp ),
      department:departments!atendimentos_current_department_id_fkey ( id, nome, cor )
    `)
    .in("status", ["pendente", "em_triagem"])
    .is("assigned_to", null)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const { data: msgs, error: mErr } = await supabase
    .from("mensagens")
    .select("atendimento_id, content, tipo, created_at, direction")
    .in("atendimento_id", ids)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false });
  if (mErr) throw mErr;

  const previewMap = new Map<string, { content: string | null; tipo: string }>();
  for (const m of msgs ?? []) {
    if (!previewMap.has(m.atendimento_id)) {
      previewMap.set(m.atendimento_id, { content: m.content, tipo: m.tipo });
    }
  }

  const now = Date.now();
  return rows.map((r) => {
    const client = r.client as { id: string; nome: string | null; numero_whatsapp: string };
    const dept = r.department as { id: string; nome: string; cor: string } | null;
    const status = r.status as AtendimentoStatus;
    const nome = client.nome ?? client.numero_whatsapp;
    const startedAt = new Date(r.created_at).getTime();
    const waitingMin = Math.max(0, Math.floor((now - startedAt) / 60000));
    const p = previewMap.get(r.id);
    return {
      id: r.id,
      clientId: client.id,
      clientNome: nome,
      clientNumero: client.numero_whatsapp,
      initials: initialsOf(nome),
      status,
      departmentId: r.current_department_id,
      departmentNome: dept?.nome ?? null,
      departmentCor: dept?.cor ?? FALLBACK_DEPT_COR,
      waitingMin,
      releasedByTimeout: (r.transferred_count ?? 0) > 0 || !!r.escalated_from_user_id,
      preview: previewFromMsg(p?.content ?? null, p?.tipo ?? null),
      createdAt: r.created_at,
    };
  });
}

export async function fetchDepartments(): Promise<DeptOption[]> {
  const { data, error } = await supabase
    .from("departments")
    .select("id, nome, cor")
    .eq("ativo", true)
    .order("ordem")
    .order("nome");
  if (error) throw error;
  return data ?? [];
}

export async function fetchCollaborators(): Promise<CollaboratorOption[]> {
  const { data, error } = await supabase
    .from("users")
    .select("id, nome, department_id, departments:department_id ( nome )")
    .eq("ativo", true)
    .eq("is_system_user", false)
    .order("nome");
  if (error) throw error;
  return (data ?? []).map((u) => {
    const dep = u.departments as { nome: string } | null;
    return {
      id: u.id,
      nome: u.nome,
      initials: initialsOf(u.nome),
      departmentId: u.department_id,
      departmentNome: dep?.nome ?? "Sem departamento",
    };
  });
}

/**
 * Atribui o atendimento atomicamente ao usuário corrente via RPC.
 * Carimba o departamento (sobrescreve se for outro/NULL) e mensagens órfãs.
 * Retorna true se ganhou, false se já havia sido pego.
 *
 * Quando assignTo === currentUserId, usa a RPC. Caso contrário (atribuição
 * para outro colaborador via "Atribuir"), faz UPDATE direto.
 */
export async function claimAtendimento(
  atendimentoId: string,
  assignTo: string,
  currentUserId: string,
): Promise<boolean> {
  if (assignTo === currentUserId) {
    const { data, error } = await supabase.rpc("claim_pendente", {
      p_atendimento_id: atendimentoId,
    });
    if (error) throw error;
    return data === true;
  }
  const { data, error } = await supabase.rpc("assign_pendente_a_usuario", {
    p_atendimento_id: atendimentoId,
    p_user_id: assignTo,
  });
  if (error) throw error;
  // Atribuiu para outro colaborador → avisa no WhatsApp pessoal dele.
  if (data === true) void notificarRepasse(atendimentoId, assignTo);
  return data === true;
}

export interface PreviewMessage {
  id: string;
  direction: "inbound" | "outbound";
  senderType: string;
  tipo: string;
  content: string | null;
  mediaUrl: string | null;
  mediaMetadata: Record<string, unknown> | null;
  createdAt: string;
}

export async function fetchUltimasMensagens(
  atendimentoId: string,
  limit = 5,
): Promise<PreviewMessage[]> {
  const { data, error } = await supabase
    .from("mensagens")
    .select("id, direction, sender_type, tipo, content, media_url, media_metadata, created_at")
    .eq("atendimento_id", atendimentoId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? [])
    .map((m) => ({
      id: m.id,
      direction: m.direction as "inbound" | "outbound",
      senderType: m.sender_type as string,
      tipo: m.tipo as string,
      content: m.content,
      mediaUrl: m.media_url,
      mediaMetadata: (m.media_metadata as Record<string, unknown> | null) ?? null,
      createdAt: m.created_at,
    }))
    .reverse();
}

export function formatWait(min: number): string {
  if (min < 1) return "agora";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m.toString().padStart(2, "0")}min`;
}
