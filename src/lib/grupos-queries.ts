import { supabase } from "@/integrations/supabase/client";
import { fetchContatoNamesByNumbers } from "@/lib/contatos-queries";
import type { MensagemRenderizavel } from "@/lib/mensagem-shape";

/**
 * Grupos de WhatsApp. Modelo separado do atendimento de propósito: grupo é um
 * canal permanente, sem triagem, bot, departamento, atribuição ou encerramento.
 * Todo membro da empresa vê e usa todos os grupos.
 */
export interface Grupo {
  id: string;
  waJid: string;
  nome: string;
  topico: string | null;
  fotoUrl: string | null;
  participantesTotal: number | null;
  souAdmin: boolean;
  somenteAdminEnvia: boolean;
  ativo: boolean;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unread: number;
  /** Última sincronização com a uazapi — usada pela trava da sync automática. */
  syncedAt: string | null;
}

export interface GrupoMessage extends MensagemRenderizavel {
  id: string;
  grupoId: string;
  direction: "inbound" | "outbound";
  senderType: "participante" | "atendente" | "sistema" | "externo";
  /** Atendente nosso que enviou (só em senderType 'atendente'). */
  sentByUserId: string | null;
  sentByNome: string | null;
  /** Participante do grupo que falou (só em inbound). */
  participanteNumero: string | null;
  participanteNome: string | null;
  statusEnvio: "aguardando_envio" | "enviando" | "enviado" | "falha";
  statusWhatsapp: "enviado" | "entregue" | "lido" | "falha_whatsapp" | null;
  replyToMessageId: string | null;
  createdAt: string;
}

/** Nome de exibição do grupo — cai para o número do JID quando não há nome. */
function nomeDoGrupo(nome: string | null, waJid: string): string {
  if (nome && nome.trim()) return nome.trim();
  return `Grupo ${waJid.split("@")[0].slice(-6)}`;
}

function previewDeMensagem(
  tipo: string | undefined,
  content: string | null | undefined,
  direction: string | undefined,
  autor: string | null,
): string {
  const corpo =
    content ??
    (tipo === "imagem"
      ? "📷 Imagem"
      : tipo === "audio"
        ? "🎤 Áudio"
        : tipo === "video"
          ? "🎥 Vídeo"
          : tipo === "documento"
            ? "📎 Documento"
            : tipo === "sticker"
              ? "Figurinha"
              : tipo
                ? `(${tipo})`
                : "");
  if (!corpo) return "";
  // Em grupo o prefixo de autor é essencial: a lista mostra conversas com
  // muitas pessoas e "Você:" / "Maria:" é o que dá contexto.
  if (direction === "outbound") return `Você: ${corpo}`;
  return autor ? `${autor}: ${corpo}` : corpo;
}

/**
 * Lista os grupos para a aba Grupos do Inbox, ordenados por atividade recente.
 * Grupos inativos (saímos ou fomos removidos) ficam de fora — o histórico deles
 * continua no banco, mas não polui a lista.
 */
export async function listGrupos(): Promise<Grupo[]> {
  const { data, error } = await supabase
    .from("grupos")
    .select(
      "id, wa_jid, nome, topico, foto_url, participantes_total, sou_admin, somente_admin_envia, ativo, last_message_at, synced_at, created_at",
    )
    .eq("ativo", true)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(300);
  if (error) throw error;

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);

  // Última mensagem de cada grupo (preview) + contadores de não lidas.
  const [previewRes, unreadRes] = await Promise.all([
    supabase
      .from("grupo_mensagens")
      .select(
        "grupo_id, content, tipo, direction, participante_nome, participante_numero, created_at",
      )
      .in("grupo_id", ids)
      .order("created_at", { ascending: false })
      .limit(1000),
    supabase.rpc("get_grupos_unread_counts", { p_grupo_ids: ids }),
  ]);
  if (previewRes.error) throw previewRes.error;
  if (unreadRes.error) throw unreadRes.error;

  const previewPorGrupo = new Map<
    string,
    {
      content: string | null;
      tipo: string;
      direction: string;
      participante_nome: string | null;
      participante_numero: string | null;
    }
  >();
  for (const m of previewRes.data ?? []) {
    if (!previewPorGrupo.has(m.grupo_id)) previewPorGrupo.set(m.grupo_id, m);
  }

  // Nome do participante do preview: contato do Google > nome público > número.
  const numerosPreview = Array.from(previewPorGrupo.values())
    .map((p) => p.participante_numero)
    .filter((n): n is string => Boolean(n));
  const contatos = await fetchContatoNamesByNumbers(numerosPreview);

  const unreadPorGrupo = new Map<string, number>(
    (unreadRes.data ?? []).map((u) => [u.grupo_id, u.unread]),
  );

  return rows.map((r) => {
    const p = previewPorGrupo.get(r.id);
    const autorPreview = p?.participante_numero
      ? (contatos.get(p.participante_numero) ?? p.participante_nome ?? p.participante_numero)
      : (p?.participante_nome ?? null);
    return {
      id: r.id,
      waJid: r.wa_jid,
      nome: nomeDoGrupo(r.nome, r.wa_jid),
      topico: r.topico,
      fotoUrl: r.foto_url,
      participantesTotal: r.participantes_total,
      souAdmin: r.sou_admin,
      somenteAdminEnvia: r.somente_admin_envia,
      ativo: r.ativo,
      lastMessageAt: r.last_message_at ?? r.created_at,
      lastMessagePreview: previewDeMensagem(p?.tipo, p?.content, p?.direction, autorPreview),
      unread: unreadPorGrupo.get(r.id) ?? 0,
      syncedAt: r.synced_at,
    };
  });
}

const COLUNAS_MENSAGEM =
  "id, grupo_id, direction, sender_type, sent_by_user_id, participante_numero, participante_nome, tipo, content, media_url, media_metadata, status_envio, status_whatsapp, reply_to_message_id, created_at, sent_by:users!grupo_mensagens_sent_by_user_id_fkey ( id, nome )";

interface LinhaMensagemGrupo {
  id: string;
  grupo_id: string;
  direction: string;
  sender_type: string;
  sent_by_user_id: string | null;
  participante_numero: string | null;
  participante_nome: string | null;
  tipo: string;
  content: string | null;
  media_url: string | null;
  media_metadata: Record<string, unknown> | null;
  status_envio: string;
  status_whatsapp: string | null;
  reply_to_message_id: string | null;
  created_at: string;
  sent_by: { id: string; nome: string } | null;
}

function mapMensagem(m: LinhaMensagemGrupo): GrupoMessage {
  return {
    id: m.id,
    grupoId: m.grupo_id,
    direction: m.direction as GrupoMessage["direction"],
    senderType: m.sender_type as GrupoMessage["senderType"],
    sentByUserId: m.sent_by_user_id,
    sentByNome: m.sent_by?.nome ?? null,
    participanteNumero: m.participante_numero,
    participanteNome: m.participante_nome,
    tipo: m.tipo as GrupoMessage["tipo"],
    content: m.content,
    mediaUrl: m.media_url,
    mediaMetadata: m.media_metadata ?? null,
    statusEnvio: m.status_envio as GrupoMessage["statusEnvio"],
    statusWhatsapp: m.status_whatsapp as GrupoMessage["statusWhatsapp"],
    replyToMessageId: m.reply_to_message_id,
    createdAt: m.created_at,
  };
}

/**
 * Página de mensagens do grupo, em ordem cronológica ASCENDENTE.
 * `beforeCreatedAt` pagina para trás (mensagens mais antigas).
 */
export async function listGrupoMensagensPage(params: {
  grupoId: string;
  beforeCreatedAt?: string | null;
  limit?: number;
}): Promise<{ messages: GrupoMessage[]; hasMore: boolean }> {
  const limit = params.limit ?? 50;
  let q = supabase
    .from("grupo_mensagens")
    .select(COLUNAS_MENSAGEM)
    .eq("grupo_id", params.grupoId)
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (params.beforeCreatedAt) q = q.lt("created_at", params.beforeCreatedAt);

  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as unknown as LinhaMensagemGrupo[];
  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  return { messages: trimmed.reverse().map(mapMensagem), hasMore };
}

/** Busca uma mensagem por id (usado pelo realtime para hidratar e deduplicar). */
export async function fetchGrupoMensagemById(id: string): Promise<GrupoMessage | null> {
  const { data, error } = await supabase
    .from("grupo_mensagens")
    .select(COLUNAS_MENSAGEM)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return mapMensagem(data as unknown as LinhaMensagemGrupo);
}

/** Ids dos grupos com alguma mensagem contendo o termo (busca da lista). */
export async function searchGrupoIdsByMessageContent(term: string): Promise<Set<string>> {
  const t = term.trim();
  if (t.length < 2) return new Set();
  const escaped = t.replace(/[\\%_]/g, (m) => `\\${m}`);
  const { data, error } = await supabase
    .from("grupo_mensagens")
    .select("grupo_id")
    .ilike("content", `%${escaped}%`)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  const set = new Set<string>();
  for (const row of data ?? []) if (row.grupo_id) set.add(row.grupo_id);
  return set;
}

export type TipoEnvioGrupo = "texto" | "image" | "video" | "document" | "audio";

/**
 * Envia mensagem para o grupo. TODO envio passa pela Edge Function
 * `grupo-enviar`: a RLS não dá INSERT em grupo_mensagens ao frontend, então a
 * autoria vem sempre do JWT e não do corpo da requisição.
 */
async function invocarEnvio(body: Record<string, unknown>): Promise<void> {
  const { data, error } = await supabase.functions.invoke("grupo-enviar", { body });
  // Resposta não-2xx vira `error` genérico no invoke; o motivo real está no corpo.
  if (error) throw new Error(mensagemDeErro(await codigoDoErro(error)));
  if (data && typeof data === "object" && (data as { ok?: boolean }).ok === false) {
    throw new Error(mensagemDeErro((data as { erro?: string }).erro));
  }
}

function mensagemDeErro(codigo: string | undefined): string {
  switch (codigo) {
    case "grupo_somente_admin":
      return "Só administradores podem enviar mensagens neste grupo.";
    case "grupo_inativo":
      return "Não estamos mais neste grupo.";
    case "grupo_nao_encontrado":
      return "Grupo não encontrado.";
    case "arquivo_muito_grande":
      return "Arquivo muito grande (máx 16 MB).";
    case "arquivo_invalido":
      return "Não foi possível ler o arquivo.";
    case "mensagem_muito_longa":
      return "Mensagem muito longa.";
    case "reply_invalido":
      return "A mensagem citada não é deste grupo.";
    case "forbidden":
      return "Você não tem permissão para enviar neste grupo.";
    default:
      return "Não foi possível enviar a mensagem.";
  }
}

export async function sendGrupoTexto(params: {
  grupoId: string;
  content: string;
  replyToMessageId?: string | null;
}): Promise<void> {
  await invocarEnvio({
    grupo_id: params.grupoId,
    tipo: "texto",
    content: params.content,
    reply_to_message_id: params.replyToMessageId ?? undefined,
  });
}

/** Blob → base64 sem o prefixo data:. Em blocos para não estourar a pilha. */
async function blobParaBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

export async function sendGrupoMedia(params: {
  grupoId: string;
  tipo: "image" | "video" | "document";
  file: File;
  caption?: string;
  replyToMessageId?: string | null;
}): Promise<void> {
  await invocarEnvio({
    grupo_id: params.grupoId,
    tipo: params.tipo,
    arquivo_base64: await blobParaBase64(params.file),
    mime_type: params.file.type || "application/octet-stream",
    nome_arquivo: params.file.name,
    content: params.caption?.trim() || undefined,
    reply_to_message_id: params.replyToMessageId ?? undefined,
  });
}

export async function sendGrupoAudio(params: {
  grupoId: string;
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  replyToMessageId?: string | null;
}): Promise<void> {
  await invocarEnvio({
    grupo_id: params.grupoId,
    tipo: "audio",
    arquivo_base64: await blobParaBase64(params.blob),
    mime_type: params.mimeType,
    nome_arquivo: "audio.ogg",
    duracao_seg: params.durationSeconds,
    reply_to_message_id: params.replyToMessageId ?? undefined,
  });
}

/** Zera o badge de não lidas do grupo para quem chamou. */
export async function marcarGrupoLido(grupoId: string): Promise<void> {
  const { error } = await supabase.rpc("marcar_grupo_lido", { p_grupo_id: grupoId });
  if (error) console.warn("[grupos] marcar_grupo_lido falhou:", error.message);
}

/** "Tique azul" do grupo no WhatsApp. Best-effort: nunca derruba a UI. */
export async function marcarGrupoLidoNoWhatsapp(grupoId: string): Promise<void> {
  const { error } = await supabase.functions.invoke("mark-chat-read", {
    body: { grupo_id: grupoId },
  });
  if (error) console.warn("[grupos] mark-chat-read (grupo) falhou:", error.message);
}

export interface ResultadoSincronizacao {
  total: number;
  novos: number;
  desativados: number;
}

function mensagemDeErroSync(codigo: string | undefined): string {
  switch (codigo) {
    case "lista_vazia_inesperada":
      // A função aborta em vez de desativar tudo (ver sincronizar-grupos/logic.ts).
      return "O WhatsApp respondeu sem nenhum grupo. Nada foi alterado — confira a conexão e tente de novo.";
    case "uazapi_indisponivel":
      return "Não foi possível falar com o WhatsApp agora. Tente de novo em instantes.";
    case "forbidden":
      return "Você não tem permissão para sincronizar grupos.";
    default:
      return "Não foi possível sincronizar os grupos agora.";
  }
}

export interface GrupoParticipante {
  numero: string;
  nome: string | null;
  /** É o número da própria instância (nosso número) conversando no grupo. */
  souNos: boolean;
}

function mensagemDeErroParticipantes(codigo: string | undefined): string {
  switch (codigo) {
    case "uazapi_indisponivel":
      return "Não foi possível falar com o WhatsApp agora. Tente de novo em instantes.";
    case "grupo_nao_encontrado":
      return "Grupo não encontrado.";
    case "forbidden":
      return "Você não tem permissão para ver os participantes deste grupo.";
    default:
      return "Não foi possível carregar os participantes agora.";
  }
}

/**
 * Lista os participantes do grupo direto na uazapi (sem cache no banco) e
 * completa o nome com a agenda de contatos quando a uazapi não souber.
 */
export async function fetchGrupoParticipantes(grupoId: string): Promise<GrupoParticipante[]> {
  const { data, error } = await supabase.functions.invoke("grupo-participantes", {
    body: { grupo_id: grupoId },
  });
  if (error) throw new Error(mensagemDeErroParticipantes(await codigoDoErro(error)));
  const r = (data ?? {}) as { ok?: boolean; erro?: string; participantes?: GrupoParticipante[] };
  if (r.ok === false) throw new Error(mensagemDeErroParticipantes(r.erro));

  const participantes = r.participantes ?? [];
  // `numero` vem em dígitos crus da uazapi; a tabela `contatos` guarda em E.164
  // (com "+"), então o cruzamento precisa normalizar antes de buscar.
  const numerosE164 = participantes.map((p) => `+${p.numero}`);
  const nomesDeContato = await fetchContatoNamesByNumbers(numerosE164);

  return (
    participantes
      .map((p) => ({
        numero: p.numero,
        // Nosso próprio número no grupo: "Você", igual ao resto do chat de grupo
        // (ver autorDaMensagem em grupos-history.ts), nunca o nome de contato.
        nome: p.souNos ? "Você" : (p.nome ?? nomesDeContato.get(`+${p.numero}`) ?? null),
        souNos: p.souNos,
      }))
      // "Você" primeiro, depois o resto em ordem alfabética.
      .sort((a, b) => {
        if (a.souNos !== b.souNos) return a.souNos ? -1 : 1;
        return (a.nome ?? a.numero).localeCompare(b.nome ?? b.numero);
      })
  );
}

/** Puxa a lista de grupos da uazapi (traz também os grupos ainda calados). */
export async function sincronizarGrupos(): Promise<ResultadoSincronizacao> {
  const { data, error } = await supabase.functions.invoke("sincronizar-grupos", { body: {} });
  // A função responde 4xx/5xx com um código no corpo; o invoke transforma isso em
  // `error` genérico, então lemos o corpo para dar a mensagem certa ao usuário.
  if (error) throw new Error(mensagemDeErroSync(await codigoDoErro(error)));
  const r = (data ?? {}) as {
    ok?: boolean;
    erro?: string;
    total?: number;
    novos?: number;
    desativados?: number;
  };
  if (r.ok === false) throw new Error(mensagemDeErroSync(r.erro));
  return { total: r.total ?? 0, novos: r.novos ?? 0, desativados: r.desativados ?? 0 };
}

/** Lê o campo `erro` do corpo de uma resposta não-2xx de Edge Function. */
async function codigoDoErro(error: unknown): Promise<string | undefined> {
  const resposta = (error as { context?: unknown })?.context;
  if (!(resposta instanceof Response)) return undefined;
  try {
    const corpo = (await resposta.clone().json()) as { erro?: string };
    return typeof corpo.erro === "string" ? corpo.erro : undefined;
  } catch {
    return undefined;
  }
}

// Cor e rótulo do autor são apresentação, não consulta: ficam em
// `grupos-history.ts` (puro, testável sem o cliente Supabase).
