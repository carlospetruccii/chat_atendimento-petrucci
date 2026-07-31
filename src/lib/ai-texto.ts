// Cliente da edge function ai-texto (assistente de escrita do composer).
// A função sempre responde 200 com { ok, texto?, erro? } — erros de negócio
// chegam no corpo, não como FunctionsHttpError.

import { supabase } from "@/integrations/supabase/client";

interface AiTextoResposta {
  ok: boolean;
  texto?: string;
  erro?: string;
}

async function invocar(body: FormData | { texto: string }): Promise<string> {
  const { data, error } = await supabase.functions.invoke<AiTextoResposta>("ai-texto", {
    body,
  });
  if (error) throw new Error("Serviço de IA indisponível no momento.");
  if (!data?.ok || !data.texto) {
    throw new Error(data?.erro ?? "A IA não retornou texto.");
  }
  return data.texto;
}

/** Transcreve o áudio ditado e devolve o texto já corrigido em pt-BR. */
export async function transcreverAudio(blob: Blob, mimeType: string): Promise<string> {
  const form = new FormData();
  form.append("file", new File([blob], "gravacao", { type: mimeType }));
  return invocar(form);
}

/** Devolve uma sugestão otimizada (ortografia/clareza) da mensagem digitada. */
export async function otimizarTexto(texto: string): Promise<string> {
  return invocar({ texto });
}
