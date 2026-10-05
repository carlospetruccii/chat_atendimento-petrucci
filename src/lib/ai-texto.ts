// Cliente da edge function ai-texto (assistente de escrita do composer).
// A função sempre responde 200 com { ok, texto?, erro? } — erros de negócio
// chegam no corpo, não como FunctionsHttpError.

import { supabase } from "@/integrations/supabase/client";
import { BUCKET_MIDIA } from "@/hooks/useSignedMediaUrl";

interface AiTextoResposta {
  ok: boolean;
  texto?: string;
  /** Transcrição crua, antes da revisão. Ainda não exibida na tela. */
  textoBruto?: string;
  erro?: string;
  /** "sem_credito" quando o gateway da IA recusou por falta de crédito (402). */
  codigo?: string;
}

export interface TranscricaoResultado {
  /** Texto final revisado — é o que vai para o composer. */
  texto: string;
  /** Transcrição crua do primeiro passo, quando disponível. */
  textoBruto: string | null;
}

/**
 * Erro de IA com o código estruturado da function, quando houver — permite ao
 * chamador diferenciar "sem crédito" (não deve seguir sem a pessoa decidir)
 * dos demais erros sem comparar a mensagem por string.
 */
export class ErroIaTexto extends Error {
  constructor(
    message: string,
    readonly codigo?: string,
  ) {
    super(message);
    this.name = "ErroIaTexto";
  }
}

export function semCredito(erro: unknown): boolean {
  return erro instanceof ErroIaTexto && erro.codigo === "sem_credito";
}

async function invocar(body: FormData | { texto: string }): Promise<AiTextoResposta> {
  const { data, error } = await supabase.functions.invoke<AiTextoResposta>("ai-texto", {
    body,
  });
  if (error) throw new ErroIaTexto("Serviço de IA indisponível no momento.");
  if (!data?.ok || !data.texto) {
    throw new ErroIaTexto(data?.erro ?? "A IA não retornou texto.", data?.codigo);
  }
  return data;
}

/**
 * Transcreve o áudio ditado e devolve o texto já corrigido em pt-BR.
 * `cliente` (quando a conversa tem um) entra na lista de palavras difíceis.
 */
export async function transcreverAudioDetalhado(
  blob: Blob,
  mimeType: string,
  cliente?: string | null,
): Promise<TranscricaoResultado> {
  const form = new FormData();
  form.append("file", new File([blob], "gravacao", { type: mimeType }));
  if (cliente?.trim()) form.append("cliente", cliente.trim());
  const data = await invocar(form);
  return { texto: data.texto!, textoBruto: data.textoBruto ?? null };
}

/** Versão curta: só o texto final. */
export async function transcreverAudio(
  blob: Blob,
  mimeType: string,
  cliente?: string | null,
): Promise<string> {
  return (await transcreverAudioDetalhado(blob, mimeType, cliente)).texto;
}

/**
 * Transcreve um áudio que já está no storage (ex.: áudio recebido do cliente).
 * Baixa direto do bucket — não usa a URL assinada do player, que expira em
 * 15 min — e reaproveita a mesma transcrição do áudio ditado (mesma chave e
 * modelo na ai-texto).
 */
export async function transcreverAudioArmazenado(storagePath: string): Promise<string> {
  const { data: blob, error } = await supabase.storage.from(BUCKET_MIDIA).download(storagePath);
  if (error || !blob) throw new ErroIaTexto("Não foi possível baixar o áudio.");
  // Objeto salvo sem content-type vem como octet-stream; áudio de WhatsApp é ogg.
  const mime = blob.type.startsWith("audio/") ? blob.type : "audio/ogg";
  return transcreverAudio(blob, mime);
}

/** Devolve uma sugestão otimizada (ortografia/clareza) da mensagem digitada. */
export async function otimizarTexto(texto: string): Promise<string> {
  return (await invocar({ texto })).texto!;
}
