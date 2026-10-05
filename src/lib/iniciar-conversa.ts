import { supabase } from "@/integrations/supabase/client";
import { cadastrarClienteSingle } from "@/lib/clientes-queries";

export interface IniciarConversaInput {
  nome: string;
  numero: string;
  /**
   * true = se o número já é cliente, mantém o nome cadastrado. Usado quando o
   * nome vem de fora e é só um rótulo (ex.: cartão de contato recebido), para
   * "Conversar" não renomear o cliente como efeito colateral.
   */
  manterNomeExistente?: boolean;
}

export interface QuemIniciou {
  userId: string | null;
  canViewAll: boolean;
}

export type ResultadoIniciarConversa =
  | { tipo: "aberta"; atendimentoId: string; jaExistia: boolean }
  | { tipo: "ocupada"; responsavel: string; departamento: string };

interface CorpoConflito {
  error?: string;
  atendimento_id?: string;
  assigned_to?: string;
  assigned_to_nome?: string;
  department_nome?: string;
  detalhe?: string;
  erro?: string;
}

/**
 * Garante o cliente pelo número e abre o atendimento atribuído a quem clicou.
 *
 * Se o cliente já está em atendimento, não cria outro: devolve o existente
 * quando dá para enxergá-lo (é meu ou vejo todos), senão diz quem está com ele.
 */
export async function iniciarConversa(
  input: IniciarConversaInput,
  quem: QuemIniciou,
): Promise<ResultadoIniciarConversa> {
  const cliente = await cadastrarClienteSingle(input.nome, input.numero, {
    manterNomeExistente: input.manterNomeExistente,
  });

  const { data, error } = await supabase.functions.invoke("iniciar-atendimento", {
    body: { client_id: cliente.cliente.id, assign_to_me: true },
  });

  if (error) {
    const ctx = (error as { context?: Response }).context;
    const corpo: CorpoConflito | null = ctx ? await ctx.json().catch(() => null) : null;
    if (corpo?.error === "cliente_com_atendimento_ativo" && corpo.atendimento_id) {
      const meu = !!corpo.assigned_to && corpo.assigned_to === quem.userId;
      if (meu || quem.canViewAll) {
        return { tipo: "aberta", atendimentoId: corpo.atendimento_id, jaExistia: true };
      }
      return {
        tipo: "ocupada",
        responsavel: corpo.assigned_to_nome ?? "outro atendente",
        departamento: corpo.department_nome ?? "outro departamento",
      };
    }
    throw new Error(corpo?.detalhe || corpo?.erro || error.message);
  }

  const resp = data as { ok?: boolean; atendimento_id?: string } | null;
  if (!resp?.ok || !resp.atendimento_id) throw new Error("Falha ao iniciar a conversa.");
  return { tipo: "aberta", atendimentoId: resp.atendimento_id, jaExistia: false };
}
