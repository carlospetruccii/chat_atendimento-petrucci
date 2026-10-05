import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { fetchContatoNamesByNumbers } from "@/lib/contatos-queries";
import type { MensagemRenderizavel } from "@/lib/mensagem-shape";
import {
  type AcaoRpcDocs,
  type DocsConversa,
  type DocsEvento,
  type DocsEventoTipo,
  type DocsFiltro,
  type DocsStatus,
  emLotes,
  mensagemErroRpcDocs,
  type PessoaDocs,
  previewDaMensagem,
} from "@/lib/docs-logic";

/**
 * Leituras e RPCs da aba Docs (número FINANCEIRO). Modelo separado da Inbox de
 * propósito, como os grupos: tabelas próprias, sem triagem, bot ou
 * departamento. Tudo que ESCREVE mensagem passa pelas Edge Functions em
 * `docs-acoes.ts`; aqui só leitura (RLS de SELECT) e as RPCs de ciclo.
 */

export interface DocsMessage extends MensagemRenderizavel {
  id: string;
  conversaId: string;
  direction: "inbound" | "outbound";
  senderType: "cliente" | "atendente" | "sistema" | "externo";
  sentByUserId: string | null;
  sentByNome: string | null;
  statusEnvio: "aguardando_envio" | "enviando" | "enviado" | "falha";
  statusWhatsapp: "enviado" | "entregue" | "lido" | "falha_whatsapp" | null;
  replyToMessageId: string | null;
  createdAt: string;
  apagadaEm: string | null;
  editadaEm: string | null;
  /** Chegou ao WhatsApp e tem id lá (régua de editar/apagar, ver janelas-whatsapp). */
  temIdWhatsapp: boolean;
}

/** Tamanho do lote de números por `.in()` na agenda de contatos (vai na URL). */
const LOTE_NUMEROS = 100;

type LinhaLista = Database["public"]["Functions"]["docs_listar_conversas"]["Returns"][number];

/** Nome de contato (Google) em lotes: a lista pode ter centenas de números. */
async function nomesDeContato(numeros: string[]): Promise<Map<string, string>> {
  const mapas = await Promise.all(emLotes(numeros, LOTE_NUMEROS).map(fetchContatoNamesByNumbers));
  return new Map(mapas.flatMap((m) => Array.from(m.entries())));
}

/** Nome dos donos. Falhar aqui não derruba a lista: cai para "outra pessoa". */
async function nomesDeUsuarios(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.from("users").select("id, nome").in("id", ids);
  if (error) {
    console.warn("[docs] nomes dos donos falharam:", error.message);
    return new Map();
  }
  return new Map((data ?? []).map((u) => [u.id, u.nome]));
}

/**
 * Lista da tela. Filtro e busca rodam no banco (docs_listar_conversas): 'sem
 * dono' e 'em andamento' voltam SEMPRE, sem teto — só o histórico (só envio,
 * encerradas) é limitado. Assim um disparo em massa de documentos não empurra
 * para fora da lista o cliente que respondeu e está esperando alguém.
 * A ordem (mais recente primeiro) já vem do banco.
 */
export async function listDocsConversas(params: {
  meuUserId: string;
  filtro: DocsFiltro;
  busca: string;
}): Promise<DocsConversa[]> {
  const { data, error } = await supabase.rpc("docs_listar_conversas", {
    p_filtro: params.filtro,
    p_busca: params.busca.trim() || undefined,
  });
  if (error) throw error;
  const rows = (data ?? []) as LinhaLista[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const donos = Array.from(new Set(rows.map((r) => r.assigned_to).filter(Boolean)));
  const numeros = rows.map((r) => r.cliente_numero).filter(Boolean);
  const [ultimasRes, unreadRes, nomesDonos, contatos] = await Promise.all([
    supabase.rpc("docs_ultimas_mensagens", { p_conversa_ids: ids }),
    supabase.rpc("get_docs_unread_counts", { p_conversa_ids: ids }),
    nomesDeUsuarios(donos),
    nomesDeContato(numeros),
  ]);
  if (ultimasRes.error) throw ultimasRes.error;
  if (unreadRes.error) throw unreadRes.error;

  const ultimas = new Map((ultimasRes.data ?? []).map((u) => [u.conversa_id, u]));
  const unread = new Map((unreadRes.data ?? []).map((u) => [u.conversa_id, u.unread]));

  return rows.map((r): DocsConversa => {
    const u = ultimas.get(r.id);
    const numero = r.cliente_numero ?? "";
    return {
      id: r.id,
      clientId: r.client_id,
      // Precedência de nome igual à Inbox: contato do Google > nome público > número.
      clientNome: contatos.get(numero) || r.cliente_nome || numero,
      clientNumero: numero,
      status: r.status,
      assignedTo: r.assigned_to ?? null,
      assignedNome: r.assigned_to ? (nomesDonos.get(r.assigned_to) ?? null) : null,
      lastMessageAt: r.last_message_at ?? null,
      lastInboundAt: r.last_inbound_at ?? null,
      createdAt: r.created_at,
      lastMessagePreview: previewDaMensagem(
        u
          ? {
              tipo: u.tipo,
              content: u.content,
              direction: u.direction,
              senderType: u.sender_type,
              apagadaEm: u.apagada_em,
              fileName: u.file_name,
            }
          : null,
        params.meuUserId,
      ),
      unread: unread.get(r.id) ?? 0,
    };
  });
}

interface LinhaConversa {
  id: string;
  client_id: string;
  status: DocsStatus;
  assigned_to: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  created_at: string;
  client: { nome: string | null; numero_whatsapp: string } | null;
  dono: { nome: string } | null;
}

const COLUNAS_CONVERSA = `id, client_id, status, assigned_to, last_message_at, last_inbound_at, created_at,
  client:clients!docs_conversas_client_same_company_fk ( nome, numero_whatsapp ),
  dono:users!docs_conversas_assigned_to_fkey ( nome )`;

/**
 * Uma conversa por id — para abrir ?conversa= que não está na lista carregada
 * (filtro ativo, busca, ou "Nova conversa" ainda sem mensagem).
 */
export async function fetchDocsConversaById(conversaId: string): Promise<DocsConversa | null> {
  const { data, error } = await supabase
    .from("docs_conversas")
    .select(COLUNAS_CONVERSA)
    .eq("id", conversaId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as unknown as LinhaConversa;
  const numero = r.client?.numero_whatsapp ?? "";
  const contatos = await fetchContatoNamesByNumbers(numero ? [numero] : []);
  return {
    id: r.id,
    clientId: r.client_id,
    clientNome: contatos.get(numero) || r.client?.nome || numero,
    clientNumero: numero,
    status: r.status,
    assignedTo: r.assigned_to,
    assignedNome: r.dono?.nome ?? null,
    lastMessageAt: r.last_message_at,
    lastInboundAt: r.last_inbound_at,
    createdAt: r.created_at,
    lastMessagePreview: "",
    unread: 0,
  };
}

/** Conversas em andamento que são minhas — destinos de "Encaminhar". */
export async function listMinhasDocsConversas(
  meuUserId: string,
): Promise<Array<Pick<DocsConversa, "id" | "clientNome" | "clientNumero">>> {
  const { data, error } = await supabase
    .from("docs_conversas")
    .select("id, client:clients!docs_conversas_client_same_company_fk ( nome, numero_whatsapp )")
    .eq("status", "em_andamento")
    .eq("assigned_to", meuUserId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as unknown as Array<Pick<LinhaConversa, "id" | "client">>).map((r) => {
    const numero = r.client?.numero_whatsapp ?? "";
    return { id: r.id, clientNome: r.client?.nome || numero, clientNumero: numero };
  });
}

/**
 * Contadores das pills que importam (e são exatos): quem está esperando dono e
 * quem está em andamento. "Todas"/"Encerradas" ficam sem número — o histórico
 * é limitado, e um número truncado enganaria.
 */
export async function contarDocsAtivas(): Promise<{ semDono: number; emAndamento: number }> {
  const contar = (status: DocsStatus) =>
    supabase
      .from("docs_conversas")
      .select("id", { count: "exact", head: true })
      .eq("status", status);
  const [semDono, emAndamento] = await Promise.all([contar("sem_dono"), contar("em_andamento")]);
  if (semDono.error) throw semDono.error;
  if (emAndamento.error) throw emAndamento.error;
  return { semDono: semDono.count ?? 0, emAndamento: emAndamento.count ?? 0 };
}

const COLUNAS_MENSAGEM =
  "id, conversa_id, direction, sender_type, sent_by_user_id, tipo, content, media_url, media_metadata, uazapi_message_id, status_envio, status_whatsapp, reply_to_message_id, created_at, apagada_em, editada_em, sent_by:users!docs_mensagens_sent_by_user_id_fkey ( id, nome )";

interface LinhaMensagem {
  id: string;
  conversa_id: string;
  direction: string;
  sender_type: string;
  sent_by_user_id: string | null;
  tipo: string;
  content: string | null;
  media_url: string | null;
  media_metadata: Record<string, unknown> | null;
  uazapi_message_id: string | null;
  status_envio: string;
  status_whatsapp: string | null;
  reply_to_message_id: string | null;
  created_at: string;
  apagada_em: string | null;
  editada_em: string | null;
  sent_by: { id: string; nome: string } | null;
}

export function mapDocsMensagem(m: LinhaMensagem): DocsMessage {
  return {
    id: m.id,
    conversaId: m.conversa_id,
    direction: m.direction as DocsMessage["direction"],
    senderType: m.sender_type as DocsMessage["senderType"],
    sentByUserId: m.sent_by_user_id,
    sentByNome: m.sent_by?.nome ?? null,
    tipo: m.tipo as DocsMessage["tipo"],
    content: m.content,
    mediaUrl: m.media_url,
    mediaMetadata: m.media_metadata ?? null,
    statusEnvio: m.status_envio as DocsMessage["statusEnvio"],
    statusWhatsapp: m.status_whatsapp as DocsMessage["statusWhatsapp"],
    replyToMessageId: m.reply_to_message_id,
    createdAt: m.created_at,
    apagadaEm: m.apagada_em,
    editadaEm: m.editada_em,
    // O id em si não sobe para a tela; só o fato de existir.
    temIdWhatsapp: !!m.uazapi_message_id,
  };
}

/**
 * Página de mensagens da conversa, em ordem cronológica ASCENDENTE.
 * `beforeCreatedAt` pagina para trás (mensagens mais antigas).
 */
export async function listDocsMensagensPage(params: {
  conversaId: string;
  beforeCreatedAt?: string | null;
  limit?: number;
}): Promise<{ messages: DocsMessage[]; hasMore: boolean }> {
  const limit = params.limit ?? 50;
  let q = supabase
    .from("docs_mensagens")
    .select(COLUNAS_MENSAGEM)
    .eq("conversa_id", params.conversaId)
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (params.beforeCreatedAt) q = q.lt("created_at", params.beforeCreatedAt);

  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as unknown as LinhaMensagem[];
  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  return { messages: trimmed.reverse().map(mapDocsMensagem), hasMore };
}

/** Uma mensagem por id (realtime e bolha recém-enviada). */
export async function fetchDocsMensagemById(id: string): Promise<DocsMessage | null> {
  const { data, error } = await supabase
    .from("docs_mensagens")
    .select(COLUNAS_MENSAGEM)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return mapDocsMensagem(data as unknown as LinhaMensagem);
}

interface LinhaEvento {
  id: string;
  tipo: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  observacao: string | null;
  created_at: string;
  actor: { nome: string } | null;
  target: { nome: string } | null;
}

/** Histórico de assumiu/repassou/encerrou, para os separadores do chat. */
export async function listDocsEventos(conversaId: string): Promise<DocsEvento[]> {
  const { data, error } = await supabase
    .from("docs_eventos")
    .select(
      `id, tipo, actor_user_id, target_user_id, observacao, created_at,
       actor:users!docs_eventos_actor_user_id_fkey ( nome ),
       target:users!docs_eventos_target_user_id_fkey ( nome )`,
    )
    .eq("conversa_id", conversaId)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw error;
  return ((data ?? []) as unknown as LinhaEvento[]).map((e) => ({
    id: e.id,
    tipo: e.tipo as DocsEventoTipo,
    actorUserId: e.actor_user_id,
    actorNome: e.actor?.nome ?? null,
    targetUserId: e.target_user_id,
    targetNome: e.target?.nome ?? null,
    observacao: e.observacao,
    createdAt: e.created_at,
  }));
}

/** Dono/status/cliente de uma conversa — o aviso global decide com isto. */
export async function fetchDocsConversaInfo(conversaId: string): Promise<{
  status: DocsStatus;
  assignedTo: string | null;
  clientNome: string;
} | null> {
  const { data, error } = await supabase
    .from("docs_conversas")
    .select(
      "status, assigned_to, client:clients!docs_conversas_client_same_company_fk ( nome, numero_whatsapp )",
    )
    .eq("id", conversaId)
    .maybeSingle();
  if (error || !data) return null;
  const client = data.client as { nome: string | null; numero_whatsapp: string } | null;
  return {
    status: data.status as DocsStatus,
    assignedTo: data.assigned_to,
    clientNome: client?.nome || client?.numero_whatsapp || "Cliente",
  };
}

// ————————————————————————————————————————————————————————————————
// RPCs de ciclo da conversa
// ————————————————————————————————————————————————————————————————

function erroDaRpc(acao: AcaoRpcDocs, error: unknown): Error {
  return new Error(mensagemErroRpcDocs(acao, (error as { code?: string } | null)?.code));
}

export async function assumirDocsConversa(conversaId: string): Promise<void> {
  const { error } = await supabase.rpc("docs_assumir", { p_conversa_id: conversaId });
  if (error) throw erroDaRpc("assumir", error);
}

export async function repassarDocsConversa(params: {
  conversaId: string;
  toUserId: string;
  observacao?: string;
}): Promise<void> {
  const { error } = await supabase.rpc("docs_repassar", {
    p_conversa_id: params.conversaId,
    p_to_user_id: params.toUserId,
    p_observacao: params.observacao?.trim() || undefined,
  });
  if (error) throw erroDaRpc("repassar", error);
}

export async function encerrarDocsConversa(conversaId: string): Promise<void> {
  const { error } = await supabase.rpc("docs_encerrar", { p_conversa_id: conversaId });
  if (error) throw erroDaRpc("encerrar", error);
}

/** Abre (ou reabre) a conversa do cliente já com quem chamou como dono. */
export async function iniciarDocsConversa(clientId: string): Promise<string> {
  const { data, error } = await supabase.rpc("docs_iniciar_conversa", { p_client_id: clientId });
  if (error) throw erroDaRpc("iniciar", error);
  if (!data) throw new Error(mensagemErroRpcDocs("iniciar", undefined));
  return data;
}

/** Zera o badge de não lidas da conversa para quem chamou. Nunca derruba a UI. */
export async function marcarDocsConversaLida(conversaId: string): Promise<void> {
  const { error } = await supabase.rpc("marcar_docs_conversa_lida", {
    p_conversa_id: conversaId,
  });
  if (error) console.warn("[docs] marcar_docs_conversa_lida falhou:", error.message);
}

/** Total do badge "Docs" no menu (sem dono + minhas). */
export async function fetchDocsUnreadTotal(): Promise<number> {
  const { data, error } = await supabase.rpc("get_my_docs_unread_total");
  if (error) throw error;
  return data ?? 0;
}

/** Pessoas ativas e se têm acesso ao Docs (destinos do repasse). */
export async function listarPessoasDocs(): Promise<PessoaDocs[]> {
  const { data, error } = await supabase.rpc("docs_listar_acesso");
  if (error) throw error;
  return (data ?? []).map((p) => ({
    userId: p.user_id,
    nome: p.nome,
    departamentoNome: p.department_nome ?? null,
    isSuperadmin: !!p.is_superadmin,
    temAcesso: !!p.tem_acesso,
  }));
}
