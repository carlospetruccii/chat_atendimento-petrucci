// Chamadas de "apagar para todos" e "editar mensagem" — recursos nativos do
// WhatsApp expostos pela edge function `mensagem-acao`.
//
// A edge function responde 200 tanto para sucesso quanto para RECUSA de negócio
// ("passou do prazo", "não é sua mensagem"), porque a recusa é informação que a
// tela precisa mostrar, não um erro de transporte. Só falha de rede/servidor
// lança daqui.

import { supabase } from "@/integrations/supabase/client";
import { type AcaoMensagem, type MotivoBloqueio, textoMotivo } from "@/lib/janelas-whatsapp";

/** Motivos que só a execução no servidor conhece. */
export type MotivoExecucao =
  | "falha_whatsapp"
  | "tempo_esgotado"
  | "mensagem_nao_encontrada"
  | "sem_permissao"
  | "limite_por_hora";

export type MotivoAcao = MotivoBloqueio | MotivoExecucao;

export const MAX_APAGAR_POR_VEZ = 10;

export interface ResultadoApagar {
  mensagemId: string;
  ok: boolean;
  motivo?: MotivoAcao;
  detalhe?: string;
}

/** Frase para o atendente, com o detalhe do servidor quando houver. */
export function explicarMotivo(
  acao: AcaoMensagem,
  motivo: MotivoAcao | undefined,
  detalhe?: string,
): string {
  if (detalhe) return detalhe;
  switch (motivo) {
    case "falha_whatsapp":
      return "O WhatsApp recusou a operação.";
    case "tempo_esgotado":
      return "Não deu tempo de processar. Tente de novo.";
    case "mensagem_nao_encontrada":
      return "Mensagem não encontrada.";
    case "sem_permissao":
      return "Você não pode agir nesta conversa.";
    case "limite_por_hora":
      return "Você já apagou muitas mensagens na última hora. Tente mais tarde.";
    case undefined:
      return "Não foi possível concluir.";
    default:
      // `?? ` porque textoMotivo só conhece os motivos de janela: se o servidor
      // ganhar um motivo novo e este arquivo não acompanhar, o aviso sai
      // genérico em vez de sair vazio.
      return textoMotivo(acao, motivo) ?? "Não foi possível concluir.";
  }
}

interface RespostaApagar {
  ok?: boolean;
  erro?: string;
  detalhe?: string;
  resultados?: Array<{
    mensagem_id: string;
    ok: boolean;
    motivo?: MotivoAcao;
    detalhe?: string;
  }>;
}

/**
 * Apaga para todos, em lote. Devolve um resultado POR MENSAGEM: o lote pode ser
 * parcial (uma dentro do prazo, outra fora) e esconder isso seria mentir sobre o
 * que o cliente ainda vê.
 */
export async function apagarMensagensParaTodos(mensagemIds: string[]): Promise<ResultadoApagar[]> {
  if (mensagemIds.length === 0) return [];

  const { data, error } = await supabase.functions.invoke<RespostaApagar>("mensagem-acao", {
    body: { acao: "apagar", mensagem_ids: mensagemIds.slice(0, MAX_APAGAR_POR_VEZ) },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.detalhe ?? data?.erro ?? "Falha ao apagar mensagens");

  return (data.resultados ?? []).map((r) => ({
    mensagemId: r.mensagem_id,
    ok: r.ok,
    motivo: r.motivo,
    detalhe: r.detalhe,
  }));
}

interface RespostaEditar {
  ok?: boolean;
  erro?: string;
  motivo?: MotivoAcao;
  detalhe?: string;
  mensagem_id?: string;
  editada_em?: string;
  conteudo?: string;
}

export interface ResultadoEditar {
  ok: boolean;
  motivo?: MotivoAcao;
  detalhe?: string;
  editadaEm?: string;
  conteudo?: string;
}

/** Edita o texto de uma mensagem já enviada. */
export async function editarMensagemEnviada(params: {
  mensagemId: string;
  texto: string;
}): Promise<ResultadoEditar> {
  const texto = params.texto.trim();
  if (!texto) return { ok: false, detalhe: "O texto não pode ficar vazio." };

  const { data, error } = await supabase.functions.invoke<RespostaEditar>("mensagem-acao", {
    body: { acao: "editar", mensagem_id: params.mensagemId, texto },
  });
  // invoke() trata status >= 400 como erro; a recusa de negócio vem em 200 com
  // ok:false, então só cai aqui quando é rede ou erro nosso de verdade.
  if (error) throw error;

  if (!data?.ok) {
    return { ok: false, motivo: data?.motivo, detalhe: data?.detalhe ?? data?.erro };
  }
  return { ok: true, editadaEm: data.editada_em, conteudo: data.conteudo };
}
