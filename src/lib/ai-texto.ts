// Cliente da edge function ai-texto (assistente de escrita do composer).
// A função sempre responde 200 com { ok, texto?, erro? } — erros de negócio
// chegam no corpo, não como FunctionsHttpError.

import { supabase } from "@/integrations/supabase/client";

interface AiTextoResposta {
  ok: boolean;
  texto?: string;
  /** Transcrição crua, antes da revisão. Ainda não exibida na tela. */
  textoBruto?: string;
  erro?: string;
}

export interface TranscricaoResultado {
  /** Texto final revisado — é o que vai para o composer. */
  texto: string;
  /** Transcrição crua do primeiro passo, quando disponível. */
  textoBruto: string | null;
}

async function invocar(body: FormData | { texto: string }): Promise<AiTextoResposta> {
  const { data, error } = await supabase.functions.invoke<AiTextoResposta>("ai-texto", {
    body,
  });
  if (error) throw new Error("Serviço de IA indisponível no momento.");
  if (!data?.ok || !data.texto) {
    throw new Error(data?.erro ?? "A IA não retornou texto.");
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

/** Devolve uma sugestão otimizada (ortografia/clareza) da mensagem digitada. */
export async function otimizarTexto(texto: string): Promise<string> {
  return (await invocar({ texto })).texto!;
}
