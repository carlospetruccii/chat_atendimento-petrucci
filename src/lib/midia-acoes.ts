import { supabase } from "@/integrations/supabase/client";

/**
 * Chat individual (`mensagens`), chat de grupo (`grupo_mensagens`) ou aba Docs
 * (`docs_mensagens`, número financeiro — reprocessa pela docs-acao).
 */
export type EscopoMidia = "individual" | "grupo" | "docs";

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
  // Motivos que só a docs-acao devolve.
  ja_apagada: "Essa mensagem foi apagada.",
  midia_propria: "Esse arquivo foi enviado daqui; não há o que baixar de novo.",
};

/**
 * Pede de novo o download de uma mídia que falhou (ou, no Docs, o primeiro
 * download de um documento do sistema financeiro, que só baixa sob demanda).
 * A função responde assim que dispara (a docs-acao responde 202): quem espera
 * o arquivo é a linha da mensagem, que chega atualizada pelo realtime.
 */
export async function reprocessarMidia(params: {
  mensagemId: string;
  escopo?: EscopoMidia;
}): Promise<ResultadoReprocessar> {
  // Docs tem tabela e instância próprias: o reprocessamento mora na docs-acao
  // (que só aceita quem tem acesso ao Docs), não na reprocessar-midia.
  const { data, error } =
    params.escopo === "docs"
      ? await supabase.functions.invoke<RespostaReprocessar>("docs-acao", {
          body: { acao: "reprocessar_midia", mensagem_id: params.mensagemId },
        })
      : await supabase.functions.invoke<RespostaReprocessar>("reprocessar-midia", {
          body: { mensagem_id: params.mensagemId, escopo: params.escopo ?? "individual" },
        });
  if (error) throw error;
  if (!data?.ok) {
    const chave = data?.motivo ?? data?.erro ?? "";
    return { ok: false, motivo: MOTIVOS[chave] ?? "Não foi possível tentar de novo agora." };
  }
  return { ok: true };
}
