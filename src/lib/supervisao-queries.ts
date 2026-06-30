import { supabase } from "@/integrations/supabase/client";
import {
  subjectLabel,
  initialsOf,
  FALLBACK_DEPT_COR,
  type AtendimentoStatus,
} from "./inbox-queries";

export { subjectLabel, initialsOf, FALLBACK_DEPT_COR };

export interface SupervisaoRow {
  id: string;
  clientNome: string;
  clientNumero: string;
  initials: string;
  status: AtendimentoStatus;
  departmentId: string | null;
  departmentNome: string | null;
  departmentCor: string;
  subjectId: string | null;
  subjectNome: string;
  assignedTo: string | null;
  assignedNome: string;
  lastMessagePreview: string;
  lastMessageAt: string | null;
  createdAt: string;
  closedAt: string | null;
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

export async function fetchSupervisao(): Promise<SupervisaoRow[]> {
  const { data, error } = await supabase
    .from("atendimentos")
    .select(`
      id, status, current_department_id, subject_id, assigned_to,
      created_at, last_message_at, closed_at,
      client:clients!inner ( id, nome, numero_whatsapp ),
      department:departments!atendimentos_current_department_id_fkey ( id, nome, cor ),
      subject:subjects!atendimentos_subject_id_fkey ( id, nome ),
      assigned:users!atendimentos_assigned_to_fkey ( id, nome )
    `)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const { data: msgs, error: mErr } = await supabase
    .from("mensagens")
    .select("atendimento_id, content, tipo, created_at")
    .in("atendimento_id", ids)
    .order("created_at", { ascending: false });
  if (mErr) throw mErr;

  const previewMap = new Map<string, { content: string | null; tipo: string }>();
  for (const m of msgs ?? []) {
    if (!previewMap.has(m.atendimento_id)) {
      previewMap.set(m.atendimento_id, { content: m.content, tipo: m.tipo });
    }
  }

  return rows.map((r) => {
    const client = r.client as { id: string; nome: string | null; numero_whatsapp: string };
    const dept = r.department as { id: string; nome: string; cor: string } | null;
    const subj = r.subject as { id: string; nome: string } | null;
    const assigned = r.assigned as { id: string; nome: string } | null;
    const status = r.status as AtendimentoStatus;
    const nome = client.nome ?? client.numero_whatsapp;
    const p = previewMap.get(r.id);
    return {
      id: r.id,
      clientNome: nome,
      clientNumero: client.numero_whatsapp,
      initials: initialsOf(nome),
      status,
      departmentId: r.current_department_id,
      departmentNome: dept?.nome ?? null,
      departmentCor: dept?.cor ?? FALLBACK_DEPT_COR,
      subjectId: r.subject_id,
      subjectNome: subjectLabel(subj?.nome ?? null, status),
      assignedTo: r.assigned_to,
      assignedNome: assigned?.nome ?? "Sem dono",
      lastMessagePreview: previewFromMsg(p?.content ?? null, p?.tipo ?? null),
      lastMessageAt: r.last_message_at,
      createdAt: r.created_at,
      closedAt: r.closed_at,
    };
  });
}

export const STATUS_LABEL: Record<AtendimentoStatus, string> = {
  em_triagem: "Em triagem",
  reservado: "Reservado",
  em_atendimento: "Em atendimento",
  pendente: "Pendente",
  encerrado: "Encerrado",
};

export const STATUS_BADGE: Record<AtendimentoStatus, string> = {
  em_triagem: "bg-amber-100 text-amber-700",
  pendente: "bg-[#F3F4F6] text-[#6B7280]",
  reservado: "bg-indigo-100 text-indigo-700",
  em_atendimento: "bg-[#DBEAFE] text-[#1E40AF]",
  encerrado: "bg-[#D1FAE5] text-[#065F46]",
};

export function formatDateShort(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatTimeShort(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  const sameDay =
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear();
  if (sameDay) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
