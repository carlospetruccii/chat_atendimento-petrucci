// Chamadas às Edge Functions da aba Docs: envio (docs-enviar), ações sobre
// mensagens já enviadas (docs-acao) e o aviso de repasse
// (docs-notificar-repasse). Todas com o JWT de quem está logado — a autoria e
// a regra "só o dono escreve" são decididas no servidor, nunca aqui.
//
// A docs-acao responde 200 com `ok:false, motivo` para recusa de NEGÓCIO (fora
// do prazo, não é o dono...). O resultado segue o formato da Inbox
// (mensagem-acoes.ts / mensagem-encaminhar.ts) para os mesmos diálogos
// mostrarem o motivo.

import { supabase } from "@/integrations/supabase/client";
import { blobParaBase64, codigoDoErro, corpoDoErro } from "@/lib/edge-functions";
import { mensagemErroEnvioDocs, normalizarMotivoDocs } from "@/lib/docs-logic";
import {
  MAX_APAGAR_POR_VEZ,
  type MotivoAcao,
  type ResultadoApagar,
  type ResultadoEditar,
} from "@/lib/mensagem-acoes";
import type { MotivoEncaminhar, ResultadoEncaminhar } from "@/lib/mensagem-encaminhar";

// ————————————————————————————————————————————————————————————————
// Envio (docs-enviar) — mesmo payload do grupo-enviar
// ————————————————————————————————————————————————————————————————

interface RespostaEnvio {
  ok?: boolean;
  erro?: string;
  mensagem_id?: string;
}

/** Devolve o id da mensagem gravada, para a tela pôr a bolha sem esperar o realtime. */
async function invocarEnvio(body: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await supabase.functions.invoke<RespostaEnvio>("docs-enviar", { body });
  // Resposta não-2xx vira `error` genérico no invoke; o motivo real está no corpo.
  if (error) throw new Error(mensagemErroEnvioDocs(await codigoDoErro(error)));
  if (data?.ok === false) throw new Error(mensagemErroEnvioDocs(data.erro));
  return typeof data?.mensagem_id === "string" ? data.mensagem_id : null;
}

export async function sendDocsTexto(params: {
  conversaId: string;
  content: string;
  replyToMessageId?: string | null;
}): Promise<string | null> {
  return invocarEnvio({
    conversa_id: params.conversaId,
    tipo: "texto",
    content: params.content,
    reply_to_message_id: params.replyToMessageId ?? undefined,
  });
}

export async function sendDocsMedia(params: {
  conversaId: string;
  tipo: "image" | "video" | "document";
  file: File;
  caption?: string;
  replyToMessageId?: string | null;
}): Promise<string | null> {
  return invocarEnvio({
    conversa_id: params.conversaId,
    tipo: params.tipo,
    arquivo_base64: await blobParaBase64(params.file),
    mime_type: params.file.type || "application/octet-stream",
    nome_arquivo: params.file.name,
    content: params.caption?.trim() || undefined,
    reply_to_message_id: params.replyToMessageId ?? undefined,
  });
}

export async function sendDocsAudio(params: {
  conversaId: string;
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  replyToMessageId?: string | null;
}): Promise<string | null> {
  return invocarEnvio({
    conversa_id: params.conversaId,
    tipo: "audio",
    arquivo_base64: await blobParaBase64(params.blob),
    mime_type: params.mimeType,
    nome_arquivo: "audio.ogg",
    duracao_seg: params.durationSeconds,
    reply_to_message_id: params.replyToMessageId ?? undefined,
  });
}

// ————————————————————————————————————————————————————————————————
// Ações sobre mensagens (docs-acao)
// ————————————————————————————————————————————————————————————————

interface RespostaAcao {
  ok?: boolean;
  erro?: string;
  motivo?: string;
  detalhe?: string;
}

const ERROS_ACAO: Record<string, string> = {
  forbidden: "Você não tem acesso ao Docs.",
  unauthorized: "Sua sessão expirou. Entre de novo.",
  copia_midia_falhou: "Não foi possível copiar o arquivo. Tente de novo.",
  midia_indisponivel: "O arquivo não está disponível agora. Tente de novo.",
  insert_falhou: "Não foi possível registrar a mensagem. Tente de novo.",
  texto_muito_longo: "Texto longo demais (máx 4096 caracteres).",
  muitas_mensagens: "Selecione no máximo 10 mensagens por vez.",
  erro_interno: "Erro no servidor. Tente de novo em instantes.",
  tempo_esgotado: "Não deu tempo de processar. Tente de novo.",
};

/**
 * Chama a docs-acao. 4xx/5xx chegam como `error` do invoke: se o corpo trouxer
 * motivo/detalhe (a edição devolve 500 com o motivo), ele vira resposta normal;
 * senão, lança com uma frase curta.
 */
async function invocarAcao<T extends RespostaAcao>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>("docs-acao", { body });
  if (!error) return (data ?? {}) as T;
  const corpo = (await corpoDoErro(error)) as T | undefined;
  if (corpo && (corpo.motivo || corpo.detalhe)) return corpo;
  const codigo = typeof corpo?.erro === "string" ? corpo.erro : "";
  throw new Error(ERROS_ACAO[codigo] ?? "Não foi possível concluir. Tente de novo.");
}

interface RespostaApagar extends RespostaAcao {
  resultados?: Array<{ mensagem_id: string; ok: boolean; motivo?: string; detalhe?: string }>;
}

/** Apaga para todos, em lote. Um resultado POR mensagem (o lote pode ser parcial). */
export async function apagarDocsMensagens(mensagemIds: string[]): Promise<ResultadoApagar[]> {
  if (mensagemIds.length === 0) return [];
  const r = await invocarAcao<RespostaApagar>({
    acao: "apagar",
    mensagem_ids: mensagemIds.slice(0, MAX_APAGAR_POR_VEZ),
  });
  if (!Array.isArray(r.resultados)) {
    throw new Error(r.detalhe ?? "Não foi possível apagar as mensagens.");
  }
  return r.resultados.map((x) => {
    const n = normalizarMotivoDocs(x.motivo);
    return {
      mensagemId: x.mensagem_id,
      ok: x.ok,
      motivo: n.motivo as MotivoAcao | undefined,
      detalhe: x.detalhe ?? n.detalhe,
    };
  });
}

interface RespostaEditar extends RespostaAcao {
  editada_em?: string;
  conteudo?: string;
}

export async function editarDocsMensagem(params: {
  mensagemId: string;
  texto: string;
}): Promise<ResultadoEditar> {
  const texto = params.texto.trim();
  if (!texto) return { ok: false, detalhe: "O texto não pode ficar vazio." };
  const r = await invocarAcao<RespostaEditar>({
    acao: "editar",
    mensagem_id: params.mensagemId,
    texto,
  });
  if (!r.ok) {
    const n = normalizarMotivoDocs(r.motivo);
    return {
      ok: false,
      motivo: n.motivo as MotivoAcao | undefined,
      detalhe: r.detalhe ?? n.detalhe,
    };
  }
  return { ok: true, editadaEm: r.editada_em, conteudo: r.conteudo };
}

interface RespostaEncaminhar extends RespostaAcao {
  mensagem_id?: string;
}

/** Encaminha para outra conversa do Docs em que eu sou o dono. */
export async function encaminharDocsMensagem(params: {
  mensagemId: string;
  destinoId: string;
}): Promise<ResultadoEncaminhar> {
  const r = await invocarAcao<RespostaEncaminhar>({
    acao: "encaminhar",
    mensagem_id: params.mensagemId,
    conversa_id_destino: params.destinoId,
  });
  if (!r.ok) {
    const n = normalizarMotivoDocs(r.motivo);
    return {
      ok: false,
      motivo: n.motivo as MotivoEncaminhar | undefined,
      detalhe: r.detalhe ?? n.detalhe,
    };
  }
  return { ok: true, mensagemId: r.mensagem_id };
}

/** "Tique azul" no WhatsApp do cliente. Só o dono; best-effort, nunca derruba a UI. */
export async function marcarDocsLidoNoWhatsapp(conversaId: string): Promise<void> {
  try {
    await invocarAcao({ acao: "marcar_lido", conversa_id: conversaId });
  } catch (e) {
    console.warn("[docs] marcar_lido falhou:", e instanceof Error ? e.message : e);
  }
}

/** Avisa o colaborador no WhatsApp pessoal que recebeu a conversa. Best-effort. */
export async function notificarRepasseDocs(conversaId: string, toUserId: string): Promise<void> {
  const { error } = await supabase.functions.invoke("docs-notificar-repasse", {
    body: { conversa_id: conversaId, to_user_id: toUserId },
  });
  if (error) console.warn("[docs] docs-notificar-repasse falhou:", error.message);
}
