import { supabase } from "@/integrations/supabase/client";

/** Chat individual (`mensagens`) ou chat de grupo (`grupo_mensagens`). */
export type EscopoMidia = "individual" | "grupo";

interface RespostaReprocessar {
  ok?: boolean;
  erro?: string;
  motivo?: string;
}

export interface ResultadoReprocessar {
  /** true = download disparado; o resultado chega pelo realtime da mensagem. */
  ok: boolean;
  /** Texto pronto para o toast quando não dá para tentar agora. */
  motivo?: string;
}

const MOTIVOS: Record<string, string> = {
  ja_disponivel: "Esse arquivo já foi baixado. Atualize a conversa.",
  tentativa_recente: "Já tem uma tentativa em andamento. Aguarde alguns segundos.",
  sem_referencia_whatsapp: "O WhatsApp não guarda mais esse arquivo.",
  tipo_sem_download: "Esse tipo de mensagem não tem arquivo para baixar.",
  grande_demais: "O arquivo passa do limite de 50 MB do sistema.",
  nao_encontrada: "Mensagem não encontrada.",
};

/**
 * Pede de novo o download de uma mídia que falhou. A função responde assim que
 * enfileira: quem espera o arquivo é a linha da mensagem, que chega atualizada
 * pelo realtime.
 */
export async function reprocessarMidia(params: {
  mensagemId: string;
  escopo?: EscopoMidia;
}): Promise<ResultadoReprocessar> {
  const { data, error } = await supabase.functions.invoke<RespostaReprocessar>(
    "reprocessar-midia",
    { body: { mensagem_id: params.mensagemId, escopo: params.escopo ?? "individual" } },
  );
  if (error) throw error;
  if (!data?.ok) {
    const chave = data?.motivo ?? data?.erro ?? "";
    return { ok: false, motivo: MOTIVOS[chave] ?? "Não foi possível tentar de novo agora." };
  }
  return { ok: true };
}
