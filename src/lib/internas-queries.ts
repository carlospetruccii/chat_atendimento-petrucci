import { supabase } from "@/integrations/supabase/client";
import type { MensagemRenderizavel } from "@/lib/mensagem-shape";
import { previewDaConversa } from "@/lib/internas-history";

/**
 * Chat interno da equipe: conversa 1:1 entre colaboradores, dentro do sistema.
 * NÃO passa pelo WhatsApp — não há número, uazapi, triagem, bot, departamento
 * de atendimento, atribuição nem encerramento.
 *
 * Toda escrita de MENSAGEM passa por RPC SECURITY DEFINER
 * (`enviar_mensagem_interna`, `enviar_midia_interna`, `abrir_conversa_interna`,
 * `marcar_conversa_interna_lida`): a RLS não dá INSERT ao frontend, então a
 * autoria vem sempre do JWT e nunca do corpo da chamada.
 *
 * A MÍDIA, ao contrário de grupo/atendimento, sobe direto daqui para o Storage
 * (não há uazapi para intermediar, então não há Edge Function). O que segura o
 * caminho direto é a policy de INSERT do bucket, restrita a
 * `internas/<conversa_id>/` de quem participa da conversa.
 */

const BUCKET_MIDIA = "mensagens-midia";

export interface ConversaInterna {
  id: string;
  /** O OUTRO participante — quem eu vejo na lista. */
  outroUserId: string;
  outroNome: string;
  outroDepartmentNome: string | null;
  outroDepartmentCor: string | null;
  outroDisponivel: boolean;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  unread: number;
}

/**
 * Estende `MensagemRenderizavel` para que os componentes de mídia
 * (`MessageMedia` e cia.) sirvam aqui sem nenhuma adaptação — os mesmos que o
 * chat individual e o de grupo usam.
 */
export interface MensagemInterna extends MensagemRenderizavel {
  id: string;
  conversaId: string;
  senderUserId: string;
  senderNome: string | null;
  createdAt: string;
}

/** Tipos de mídia que a conversa interna aceita (sem figurinha/local/contato). */
export type TipoMidiaInterna = "imagem" | "audio" | "video" | "documento";

export interface ColegaInterno {
  userId: string;
  nome: string;
  departmentNome: string | null;
  departmentCor: string | null;
  disponivel: boolean;
  /** Conversa já existente com essa pessoa, se houver. */
  conversaId: string | null;
}

/**
 * Minhas conversas internas, mais recentes primeiro. Uma ida ao banco só: o RPC
 * já devolve o outro participante, o preview e o contador de não lidas.
 */
export async function listConversasInternas(): Promise<ConversaInterna[]> {
  const { data, error } = await supabase.rpc("listar_conversas_internas");
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.conversa_id,
    outroUserId: r.outro_user_id,
    outroNome: r.outro_nome,
    outroDepartmentNome: r.outro_department_nome,
    outroDepartmentCor: r.outro_department_cor,
    outroDisponivel: r.outro_disponivel,
    lastMessageAt: r.last_message_at,
    lastMessagePreview: previewDaConversa(
      r.last_message_content,
      r.last_message_tipo,
      r.last_message_de_mim,
    ),
    unread: r.unread ?? 0,
  }));
}

/** Colegas com quem posso conversar (exclui eu, Bot/Sistema e desligados). */
export async function listColegasInternos(): Promise<ColegaInterno[]> {
  const { data, error } = await supabase.rpc("listar_colegas_internos");
  if (error) throw error;
  return (data ?? []).map((r) => ({
    userId: r.user_id,
    nome: r.nome,
    departmentNome: r.department_nome,
    departmentCor: r.department_cor,
    disponivel: r.disponivel,
    conversaId: r.conversa_id,
  }));
}

const COLUNAS_MENSAGEM =
  "id, conversa_id, sender_user_id, tipo, content, media_metadata, created_at, sender:users!mensagens_internas_sender_user_id_fkey ( id, nome )";

interface LinhaMensagemInterna {
  id: string;
  conversa_id: string;
  sender_user_id: string;
  tipo: string;
  content: string | null;
  media_metadata: Record<string, unknown> | null;
  created_at: string;
  sender: { id: string; nome: string } | null;
}

function mapMensagem(m: LinhaMensagemInterna): MensagemInterna {
  return {
    id: m.id,
    conversaId: m.conversa_id,
    senderUserId: m.sender_user_id,
    senderNome: m.sender?.nome ?? null,
    tipo: m.tipo as MensagemInterna["tipo"],
    content: m.content,
    // Conversa interna não tem URL externa: o arquivo sempre mora no nosso
    // bucket e é lido pelo `storage_path` do metadata.
    mediaUrl: null,
    mediaMetadata: m.media_metadata ?? null,
    createdAt: m.created_at,
  };
}

/**
 * Página de mensagens em ordem cronológica ASCENDENTE.
 * `beforeCreatedAt` pagina para trás (mensagens mais antigas).
 */
export async function listMensagensInternasPage(params: {
  conversaId: string;
  beforeCreatedAt?: string | null;
  limit?: number;
}): Promise<{ messages: MensagemInterna[]; hasMore: boolean }> {
  const limit = params.limit ?? 50;
  let q = supabase
    .from("mensagens_internas")
    .select(COLUNAS_MENSAGEM)
    .eq("conversa_id", params.conversaId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (params.beforeCreatedAt) q = q.lt("created_at", params.beforeCreatedAt);

  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as unknown as LinhaMensagemInterna[];
  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  return { messages: trimmed.reverse().map(mapMensagem), hasMore };
}

/** Busca uma mensagem por id (o realtime usa para hidratar e deduplicar). */
export async function fetchMensagemInternaById(id: string): Promise<MensagemInterna | null> {
  const { data, error } = await supabase
    .from("mensagens_internas")
    .select(COLUNAS_MENSAGEM)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return mapMensagem(data as unknown as LinhaMensagemInterna);
}

/** Abre (ou reaproveita) a conversa com um colega. Idempotente. */
export async function abrirConversaInterna(outroUserId: string): Promise<string> {
  const { data, error } = await supabase.rpc("abrir_conversa_interna", {
    p_outro_user_id: outroUserId,
  });
  if (error) throw new Error(mensagemDeErro(error.message));
  if (!data) throw new Error("Não foi possível abrir a conversa.");
  return data as string;
}

export async function enviarMensagemInterna(params: {
  conversaId: string;
  content: string;
}): Promise<void> {
  const { error } = await supabase.rpc("enviar_mensagem_interna", {
    p_conversa_id: params.conversaId,
    p_content: params.content,
  });
  if (error) throw new Error(mensagemDeErro(error.message));
}

/** Extensão a partir do nome do arquivo, para o objeto no bucket não ficar sem. */
function extensaoDe(nome: string, fallback: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(nome);
  return m ? m[1].toLowerCase() : fallback;
}

/**
 * Sobe o arquivo para `internas/<conversa_id>/` e registra a mensagem.
 *
 * Ordem: upload PRIMEIRO, registro depois. Se o registro falhar, sobra um
 * objeto órfão no bucket — inofensivo, porque a policy de SELECT só libera
 * objeto referenciado por mensagem de conversa da qual você participa, então
 * ninguém consegue lê-lo. A ordem inversa deixaria a bolha na tela apontando
 * para arquivo que não existe, que é pior de ver.
 */
export async function enviarMidiaInterna(params: {
  conversaId: string;
  tipo: TipoMidiaInterna;
  arquivo: Blob;
  nomeArquivo: string;
  caption?: string;
  duracaoSegundos?: number;
}): Promise<void> {
  const ext = extensaoDe(params.nomeArquivo, params.tipo === "audio" ? "ogg" : "bin");
  const storagePath = `internas/${params.conversaId}/${crypto.randomUUID()}.${ext}`;

  const up = await supabase.storage.from(BUCKET_MIDIA).upload(storagePath, params.arquivo, {
    contentType: params.arquivo.type || "application/octet-stream",
    upsert: false,
  });
  if (up.error) throw new Error(mensagemDeErroUpload(up.error.message));

  const { error } = await supabase.rpc("enviar_midia_interna", {
    p_conversa_id: params.conversaId,
    p_tipo: params.tipo,
    p_storage_path: storagePath,
    p_content: params.caption?.trim() || undefined,
    p_file_name: params.nomeArquivo,
    p_tamanho_bytes: params.arquivo.size,
    p_duracao_seg: params.duracaoSegundos,
  });
  if (error) throw new Error(mensagemDeErro(error.message));
}

function mensagemDeErroUpload(raw: string | undefined): string {
  const m = raw ?? "";
  // A policy de INSERT do bucket nega com erro de RLS; traduzimos para algo
  // acionável em vez de mostrar "new row violates row-level security".
  if (/row-level security|Unauthorized|403/i.test(m)) {
    return "Você não tem permissão para enviar arquivo nesta conversa.";
  }
  if (/exceeded the maximum allowed size|Payload too large|413/i.test(m)) {
    return "Arquivo muito grande.";
  }
  return "Não foi possível enviar o arquivo. Tente de novo.";
}

/** Zera o badge de não lidas da conversa para quem chamou. */
export async function marcarConversaInternaLida(conversaId: string): Promise<void> {
  const { error } = await supabase.rpc("marcar_conversa_interna_lida", {
    p_conversa_id: conversaId,
  });
  if (error) console.warn("[internas] marcar_conversa_interna_lida falhou:", error.message);
}

/**
 * Os RPCs sinalizam erro com RAISE EXCEPTION, então o motivo chega como texto
 * dentro de `error.message`. Traduzimos por código para não vazar SQL na tela.
 */
function mensagemDeErro(raw: string | undefined): string {
  const m = raw ?? "";
  if (m.includes("mensagem_vazia")) return "Escreva algo antes de enviar.";
  if (m.includes("mensagem_muito_longa")) return "Mensagem muito longa (máx 4000 caracteres).";
  if (m.includes("destinatario_invalido")) return "Essa pessoa não está disponível para conversa.";
  if (m.includes("tipo_invalido")) return "Esse tipo de arquivo não é aceito aqui.";
  if (m.includes("storage_path_invalido")) return "Arquivo inválido para esta conversa.";
  if (m.includes("forbidden")) return "Você não participa dessa conversa.";
  if (m.includes("nao_autenticado")) return "Sua sessão expirou. Entre de novo.";
  if (m.includes("sem_empresa")) return "Seu usuário não está vinculado à empresa.";
  return "Não foi possível enviar a mensagem.";
}
