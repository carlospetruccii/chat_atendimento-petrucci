import { supabase } from "@/integrations/supabase/client";
import { fetchContatoNamesByNumbers } from "@/lib/contatos-queries";

export type AtendimentoStatus =
  | "em_triagem"
  | "reservado"
  | "pendente"
  | "em_atendimento"
  | "encerrado";

export interface InboxConversation {
  id: string;
  clientId: string;
  clientNome: string;
  clientNumero: string;
  status: AtendimentoStatus;
  departmentId: string | null;
  departmentNome: string | null;
  departmentCor: string | null;
  assignedTo: string | null;
  assignedNome: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unread: number;
}

export interface InboxMessage {
  id: string;
  atendimentoId: string;
  direction: "inbound" | "outbound";
  senderType: "cliente" | "atendente" | "bot" | "sistema" | "externo";
  sentByUserId: string | null;
  sentByNome: string | null;
  tipo:
    | "texto"
    | "imagem"
    | "audio"
    | "video"
    | "documento"
    | "sticker"
    | "localizacao"
    | "contato";
  content: string | null;
  mediaUrl: string | null;
  mediaMetadata: Record<string, unknown> | null;
  createdAt: string;
  replyToMessageId: string | null;
}

// Mantido para referência; usuários comuns filtram inline abaixo.
const ACTIVE_STATUSES: AtendimentoStatus[] = ["em_triagem", "reservado", "em_atendimento"];
void ACTIVE_STATUSES;

interface ListConversationsParams {
  userId: string;
  isSuperadmin: boolean;
  canViewAll: boolean;
}

/**
 * Atendentes comuns: só veem atendimentos atribuídos a eles em status ativo (reservado / em_atendimento).
 * Administrador / quem tem view_all_departments: vê todos os atendimentos em andamento, incluindo triagem.
 */
export async function listInboxConversations(
  params: ListConversationsParams,
): Promise<InboxConversation[]> {
  let query = supabase
    .from("atendimentos")
    .select(
      `
      id,
      status,
      assigned_to,
      current_department_id,
      last_message_at,
      created_at,
      client:clients!atendimentos_client_id_fkey!inner ( id, nome, numero_whatsapp ),
      department:departments!atendimentos_current_department_id_fkey ( id, nome, cor ),
      assigned:users!atendimentos_assigned_to_fkey ( id, nome )
    `,
    )
    // nullsFirst: atendimentos recém-abertos (sem mensagem ainda) não podem cair
    // fora do limit — a ordem de verdade é resolvida abaixo, por atividade.
    .order("last_message_at", { ascending: false, nullsFirst: true });

  if (params.canViewAll) {
    // Administrador / superadmin: vê todos os status, inclusive encerrados,
    // misturados em ordem cronológica.
  } else {
    query = query.eq("assigned_to", params.userId).in("status", ["reservado", "em_atendimento"]);
  }

  const { data, error } = await query.limit(500);
  if (error) throw error;

  // Ordena por atividade: última mensagem ou, quando ainda não houve nenhuma
  // (atendimento aberto pela tela Contatos), a criação. Sem isso um atendimento
  // novo ficava atrás de um antigo do mesmo cliente e era descartado no dedup —
  // e o chat não abria ao vir de "Conversar".
  const atividade = (r: { last_message_at: string | null; created_at: string }): number =>
    new Date(r.last_message_at ?? r.created_at).getTime();

  // Dedup por cliente: o primeiro registro de cada client.id é o mais recente.
  const seenClients = new Set<string>();
  const rowsRaw = [...(data ?? [])].sort((a, b) => atividade(b) - atividade(a));
  const rows = [] as typeof rowsRaw;
  for (const r of rowsRaw) {
    const c = r.client as { id: string } | null;
    const cid = c?.id;
    if (!cid) continue;
    if (seenClients.has(cid)) continue;
    seenClients.add(cid);
    rows.push(r);
    if (rows.length >= 200) break;
  }
  if (rows.length === 0) return [];

  // Buscar última mensagem de cada atendimento (preview)
  const ids = rows.map((r) => r.id);
  const { data: lastMsgs, error: msgErr } = await supabase
    .from("mensagens")
    .select("atendimento_id, content, tipo, direction, created_at")
    .in("atendimento_id", ids)
    .order("created_at", { ascending: false });
  if (msgErr) throw msgErr;

  const previewByAtendimento = new Map<
    string,
    { content: string | null; tipo: string; direction: string }
  >();
  for (const m of lastMsgs ?? []) {
    if (!previewByAtendimento.has(m.atendimento_id)) {
      previewByAtendimento.set(m.atendimento_id, {
        content: m.content,
        tipo: m.tipo,
        direction: m.direction,
      });
    }
  }

  // Precedência de nome: contato do Google > nome público WhatsApp > número.
  const numeros = rows
    .map((r) => (r.client as { numero_whatsapp?: string } | null)?.numero_whatsapp)
    .filter((n): n is string => Boolean(n));
  const contatoNames = await fetchContatoNamesByNumbers(numeros);

  const { data: unreadRows, error: unreadErr } = await supabase.rpc(
    "get_atendimentos_unread_counts",
    { p_atendimento_ids: ids },
  );
  if (unreadErr) throw unreadErr;
  const unreadByAtendimento = new Map<string, number>(
    (unreadRows ?? []).map((u) => [u.atendimento_id, u.unread]),
  );

  return rows.map((r) => {
    const client = r.client as { id: string; nome: string | null; numero_whatsapp: string };
    const dept = r.department as { id: string; nome: string; cor: string } | null;
    const assigned = r.assigned as { id: string; nome: string } | null;
    const preview = previewByAtendimento.get(r.id);
    const previewBody =
      preview?.content ??
      (preview?.tipo === "imagem"
        ? "📷 Imagem"
        : preview?.tipo === "audio"
          ? "🎤 Áudio"
          : preview?.tipo === "video"
            ? "🎥 Vídeo"
            : preview?.tipo === "documento"
              ? "📎 Documento"
              : preview?.tipo
                ? `(${preview.tipo})`
                : "");
    const previewText =
      previewBody && preview?.direction === "outbound" ? `Você: ${previewBody}` : previewBody;

    return {
      id: r.id,
      clientId: client.id,
      clientNome:
        contatoNames.get(client.numero_whatsapp) ?? client.nome ?? client.numero_whatsapp,
      clientNumero: client.numero_whatsapp,
      status: r.status as AtendimentoStatus,
      departmentId: r.current_department_id,
      departmentNome: dept?.nome ?? null,
      departmentCor: dept?.cor ?? null,
      assignedTo: r.assigned_to,
      assignedNome: assigned?.nome ?? null,
      lastMessageAt: r.last_message_at ?? r.created_at,
      lastMessagePreview: previewText,
      unread: unreadByAtendimento.get(r.id) ?? 0,
    };
  });
}

/**
 * Busca atendimentos cujo conteúdo de alguma mensagem contém o termo.
 * Retorna o conjunto de client_ids correspondentes (RLS já filtra o que o usuário pode ver).
 */
export async function searchClientIdsByMessageContent(term: string): Promise<Set<string>> {
  const t = term.trim();
  if (t.length < 2) return new Set();
  // Escapa caracteres especiais do LIKE
  const escaped = t.replace(/[\\%_]/g, (m) => `\\${m}`);
  const { data, error } = await supabase
    .from("mensagens")
    .select("client_id, content, created_at")
    .ilike("content", `%${escaped}%`)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  const set = new Set<string>();
  for (const row of data ?? []) {
    if (row.client_id) set.add(row.client_id);
  }
  return set;
}

const MESSAGE_COLUMNS =
  "id, atendimento_id, direction, sender_type, sent_by_user_id, tipo, content, media_url, media_metadata, reply_to_message_id, created_at, sent_by:users!mensagens_sent_by_user_id_fkey ( id, nome )";

type RawMessageRow = {
  id: string;
  atendimento_id: string;
  direction: string;
  sender_type: string;
  sent_by_user_id: string | null;
  tipo: string;
  content: string | null;
  media_url: string | null;
  media_metadata: Record<string, unknown> | null;
  reply_to_message_id: string | null;
  created_at: string;
  sent_by: { id: string; nome: string } | null;
};

function mapMessage(m: RawMessageRow): InboxMessage {
  return {
    id: m.id,
    atendimentoId: m.atendimento_id,
    direction: m.direction as "inbound" | "outbound",
    senderType: m.sender_type as InboxMessage["senderType"],
    sentByUserId: m.sent_by_user_id,
    sentByNome: m.sent_by?.nome ?? null,
    tipo: m.tipo as InboxMessage["tipo"],
    content: m.content,
    mediaUrl: m.media_url,
    mediaMetadata: m.media_metadata ?? null,
    replyToMessageId: m.reply_to_message_id ?? null,
    createdAt: m.created_at,
  };
}

export interface ClientAtendimentoSummary {
  id: string;
  status: AtendimentoStatus;
  currentDepartmentId: string | null;
  departmentNome: string | null;
  departmentCor: string | null;
  createdAt: string;
  closedAt: string | null;
  lastMessageAt: string | null;
}

/**
 * Atendimentos do cliente que entram no scroll contínuo da conversa atual.
 * - Atendente comum: atual + último encerrado do MESMO departamento (no máx. 2).
 * - Administrador / view_all_departments: TODOS os atendimentos do cliente.
 *
 * RLS faz o resto: queries que retornam linhas que o usuário não pode ver
 * simplesmente vêm vazias.
 */
export async function listClientAtendimentosVisiveis(params: {
  clientId: string;
  currentAtendimentoId: string;
  currentDepartmentId: string | null;
  canViewAll: boolean;
}): Promise<ClientAtendimentoSummary[]> {
  const base = supabase
    .from("atendimentos")
    .select(
      `id, status, current_department_id, created_at, closed_at, last_message_at,
       department:departments!atendimentos_current_department_id_fkey ( id, nome, cor )`,
    )
    .eq("client_id", params.clientId);

  const { data, error } = params.canViewAll
    ? await base.order("created_at", { ascending: false }).limit(200)
    : await (async () => {
        // Atual + último encerrado do mesmo depto.
        const atual = base
          .eq("id", params.currentAtendimentoId)
          .order("created_at", { ascending: false })
          .limit(1);
        const [atualRes, anteriorRes] = await Promise.all([
          atual,
          params.currentDepartmentId
            ? supabase
                .from("atendimentos")
                .select(
                  `id, status, current_department_id, created_at, closed_at, last_message_at,
                   department:departments!atendimentos_current_department_id_fkey ( id, nome, cor )`,
                )
                .eq("client_id", params.clientId)
                .eq("current_department_id", params.currentDepartmentId)
                .eq("status", "encerrado")
                .neq("id", params.currentAtendimentoId)
                .order("closed_at", { ascending: false, nullsFirst: false })
                .limit(1)
            : Promise.resolve({ data: [], error: null as null }),
        ]);
        if (atualRes.error) return { data: null, error: atualRes.error };
        if (anteriorRes.error) return { data: null, error: anteriorRes.error };
        return {
          data: [...(atualRes.data ?? []), ...(anteriorRes.data ?? [])],
          error: null,
        };
      })();

  if (error) throw error;
  return (data ?? []).map((r) => {
    const dept = r.department as { id: string; nome: string; cor: string } | null;
    return {
      id: r.id,
      status: r.status as AtendimentoStatus,
      currentDepartmentId: r.current_department_id,
      departmentNome: dept?.nome ?? null,
      departmentCor: dept?.cor ?? null,
      createdAt: r.created_at,
      closedAt: r.closed_at,
      lastMessageAt: r.last_message_at,
    };
  });
}

// ============ Cadeia de atendentes (linha do tempo) ============

// Um passo da cadeia de quem atendeu: a pessoa que assumiu o atendimento e,
// quando o evento registra, em qual departamento.
export interface AtendenteChainItem {
  userId: string;
  nome: string;
  departmentNome: string | null;
  departmentCor: string | null;
  at: string;
}

// Eventos que atribuem o atendimento a uma PESSOA (target_user_id). Não inclui
// 'encerrado' (o ator que fecha já é o último da cadeia) nem os
// 'iniciado_atendimento' de origem externa (sem target).
const EVENTOS_ATRIBUICAO = [
  "reservado",
  "atribuido",
  "iniciado_atendimento",
  "reabertura_automatica",
  "repassado",
] as const;

export interface RawTimelineRow {
  atendimento_id: string;
  target_user_id: string | null;
  created_at: string;
  target: { nome: string } | null;
  to_department: { nome: string; cor: string } | null;
}

// PURA: monta, por atendimento, a sequência ordenada de quem atendeu, colapsando
// repetições consecutivas da mesma pessoa (só marca troca de responsável).
// `rows` precisa vir ordenado por created_at ASC.
export function construirCadeiasAtendentes(
  rows: RawTimelineRow[],
): Record<string, AtendenteChainItem[]> {
  const porAtendimento: Record<string, AtendenteChainItem[]> = {};
  for (const r of rows) {
    if (!r.target_user_id) continue;
    const cadeia = (porAtendimento[r.atendimento_id] ??= []);
    const anterior = cadeia[cadeia.length - 1];
    if (anterior && anterior.userId === r.target_user_id) {
      // Mesma pessoa de novo em sequência: atualiza só o departamento se veio um.
      if (r.to_department) {
        anterior.departmentNome = r.to_department.nome;
        anterior.departmentCor = r.to_department.cor;
      }
      continue;
    }
    cadeia.push({
      userId: r.target_user_id,
      nome: r.target?.nome ?? "—",
      departmentNome: r.to_department?.nome ?? null,
      departmentCor: r.to_department?.cor ?? null,
      at: r.created_at,
    });
  }
  return porAtendimento;
}

/**
 * Cadeia de atendentes de vários atendimentos, para a Linha do tempo.
 * Retorna um mapa atendimento_id → passos (na ordem em que assumiram).
 * Só admin/view_all abre a Linha do tempo; a RLS de timeline_events já
 * restringe o que cada um pode ler.
 */
export async function listAtendentesChain(
  atendimentoIds: string[],
): Promise<Record<string, AtendenteChainItem[]>> {
  if (atendimentoIds.length === 0) return {};
  const { data, error } = await supabase
    .from("timeline_events")
    .select(
      `atendimento_id, target_user_id, created_at,
       target:users!timeline_events_target_user_id_fkey ( nome ),
       to_department:departments!timeline_events_to_department_id_fkey ( nome, cor )`,
    )
    .in("atendimento_id", atendimentoIds)
    .in("tipo_evento", EVENTOS_ATRIBUICAO)
    .not("target_user_id", "is", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return construirCadeiasAtendentes((data ?? []) as unknown as RawTimelineRow[]);
}

/**
 * Página de mensagens do scroll contínuo. Retorna até `limit` mensagens
 * em ordem cronológica ASCENDENTE; cursor `beforeCreatedAt` para paginar
 * para trás (mensagens mais antigas).
 */
export async function listInboxMessagesPage(params: {
  atendimentoIds: string[];
  beforeCreatedAt?: string | null;
  limit?: number;
}): Promise<{ messages: InboxMessage[]; hasMore: boolean }> {
  const limit = params.limit ?? 50;
  if (params.atendimentoIds.length === 0) {
    return { messages: [], hasMore: false };
  }
  let q = supabase
    .from("mensagens")
    .select(MESSAGE_COLUMNS)
    .in("atendimento_id", params.atendimentoIds)
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (params.beforeCreatedAt) {
    q = q.lt("created_at", params.beforeCreatedAt);
  }
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as RawMessageRow[];
  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  // Inverte para ASC.
  return {
    messages: trimmed.reverse().map(mapMessage),
    hasMore,
  };
}

/**
 * "Ilha" de mensagens de UM atendimento específico — usada quando a Administrador
 * clica num atendimento no painel Linha do Tempo e queremos carregar o bloco
 * inteiro de uma vez (sem ficar paginando).
 */
export async function listMessagesForAtendimento(atendimentoId: string): Promise<InboxMessage[]> {
  const { data, error } = await supabase
    .from("mensagens")
    .select(MESSAGE_COLUMNS)
    .eq("atendimento_id", atendimentoId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as RawMessageRow[]).map(mapMessage);
}

/** Busca uma única mensagem por id (usado pelo realtime para dedupe + map). */
export async function fetchMessageById(id: string): Promise<InboxMessage | null> {
  const { data, error } = await supabase
    .from("mensagens")
    .select(MESSAGE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return mapMessage(data as RawMessageRow);
}

/**
 * Insere uma mensagem outbound do atendente atual e dispara o envio Z-API
 * via edge function existente `send-whatsapp-message`.
 */
export async function sendInboxMessage(params: {
  atendimentoId: string;
  clientId: string;
  departmentId: string | null;
  userId: string;
  content: string;
  replyToMessageId?: string | null;
}): Promise<void> {
  const { error } = await supabase.from("mensagens").insert({
    atendimento_id: params.atendimentoId,
    client_id: params.clientId,
    department_id: params.departmentId,
    direction: "outbound",
    sender_type: "atendente",
    sent_by_user_id: params.userId,
    tipo: "texto",
    content: params.content,
    status_envio: "aguardando_envio",
    reply_to_message_id: params.replyToMessageId ?? null,
  });
  if (error) throw error;

  // Dispara a edge function que cuida do envio Z-API
  const { error: fnErr } = await supabase.functions.invoke("send-whatsapp-message", {
    body: { atendimento_id: params.atendimentoId },
  });
  if (fnErr) {
    // Não derruba a UI: a mensagem já está no banco e o cron de retry tentará reenviar.
    console.warn("[inbox] send-whatsapp-message falhou:", fnErr.message);
  }
}

/**
 * Marca a conversa como lida no WhatsApp (dispara o "tique azul" para o
 * remetente). Best-effort: nunca derruba a UI — a Edge Function ainda revalida
 * server-side que quem chamou é o atendente responsável e o atendimento está
 * em andamento antes de acionar a uazapi.
 */
export async function marcarConversaLida(atendimentoId: string): Promise<void> {
  const { error } = await supabase.functions.invoke("mark-chat-read", {
    body: { atendimento_id: atendimentoId },
  });
  if (error) {
    console.warn("[inbox] mark-chat-read falhou:", error.message);
  }
}

/**
 * Zera o contador de mensagens não lidas (badge interno) para quem chamou,
 * ao abrir a conversa. Independente do "tique azul" do WhatsApp acima —
 * qualquer usuário que abrir a conversa marca como lida para si mesmo.
 */
export async function marcarAtendimentoLido(atendimentoId: string): Promise<void> {
  const { error } = await supabase.rpc("marcar_atendimento_lido", {
    p_atendimento_id: atendimentoId,
  });
  if (error) {
    console.warn("[inbox] marcar_atendimento_lido falhou:", error.message);
  }
}

/**
 * Avisa no WhatsApp pessoal do colaborador que um atendimento foi repassado/
 * atribuído a ele. Best-effort: chamada logo após o repasse concluir, nunca
 * derruba a UI nem bloqueia o fluxo — a Edge Function revalida server-side que
 * o repasse é real e vigente antes de disparar a uazapi. Colaborador sem
 * WhatsApp cadastrado simplesmente não recebe (a função responde ok/skip).
 */
export async function notificarRepasse(
  atendimentoId: string,
  toUserId: string,
): Promise<void> {
  const { error } = await supabase.functions.invoke("notificar-repasse", {
    body: { atendimento_id: atendimentoId, to_user_id: toUserId },
  });
  if (error) {
    console.warn("[inbox] notificar-repasse falhou:", error.message);
  }
}

/**
 * Envia áudio gravado pelo atendente. Faz upload + dispatch via edge function
 * `send-whatsapp-audio` (que escreve no bucket privado e chama a Z-API).
 */
export async function sendInboxAudio(params: {
  atendimentoId: string;
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  replyToMessageId?: string | null;
}): Promise<void> {
  // Converte blob → base64 (sem o prefixo data:..;base64,)
  const arrayBuf = await params.blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  const base64 = btoa(binary);

  const { data, error } = await supabase.functions.invoke("send-whatsapp-audio", {
    body: {
      atendimento_id: params.atendimentoId,
      audio_base64: base64,
      mime_type: params.mimeType,
      duracao_seg: params.durationSeconds,
      reply_to_message_id: params.replyToMessageId ?? undefined,
    },
  });
  if (error) throw error;
  if (data && typeof data === "object" && (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { erro?: string }).erro ?? "Falha no envio do áudio");
  }
}

/**
 * Envia mídia (imagem, vídeo ou documento) anexada pelo atendente.
 * Faz upload + dispatch via edge function `send-whatsapp-media`.
 */
export async function sendInboxMedia(params: {
  atendimentoId: string;
  tipo: "image" | "video" | "document";
  file: File;
  caption?: string;
  replyToMessageId?: string | null;
}): Promise<void> {
  const arrayBuf = await params.file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  const base64 = btoa(binary);

  const { data, error } = await supabase.functions.invoke("send-whatsapp-media", {
    body: {
      atendimento_id: params.atendimentoId,
      tipo: params.tipo,
      arquivo_base64: base64,
      mime_type: params.file.type || "application/octet-stream",
      nome_arquivo: params.file.name,
      caption: params.caption?.trim() || undefined,
      reply_to_message_id: params.replyToMessageId ?? undefined,
    },
  });
  if (error) throw error;
  if (data && typeof data === "object" && (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { erro?: string }).erro ?? "Falha no envio da mídia");
  }
}
/** Iniciais do nome para o avatar. */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
}

/** Fallback de cor de departamento (quando atendimento ainda não tem departamento). */
export const FALLBACK_DEPT_COR = "#64748b";

export function statusLabel(status: AtendimentoStatus): string {
  switch (status) {
    case "em_triagem":
      return "Em triagem";
    case "reservado":
      return "Reservado";
    case "pendente":
      return "Pendente";
    case "em_atendimento":
      return "Em atendimento";
    case "encerrado":
      return "Encerrado";
  }
}
