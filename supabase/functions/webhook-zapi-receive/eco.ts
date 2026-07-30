// Adoção do eco: acesso a banco. A decisão de qual linha casa mora em
// ./eco-logic.ts (pura e testada). Ver o cabeçalho de lá para o porquê.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { log } from "../_shared/logger.ts";
import { candidatasParaAdocao, type CandidataEco, type EcoRecebido } from "./eco-logic.ts";

const FUNCAO = "webhook-zapi-receive";

// Janela de busca: o eco chega em segundos; 10 min cobre com folga uma fila
// lenta sem abrir espaço para casar com mensagem antiga.
const JANELA_MS = 10 * 60 * 1000;
const MAX_CANDIDATAS = 20;

// Espera antes da SEGUNDA tentativa de reconhecer o eco como nosso.
//
// Quem envia grava a linha no banco em milissegundos, mas nem sempre antes do
// eco voltar da uazapi (o `triagem-bot`, por exemplo, só grava DEPOIS que o
// envio responde). Sem esta folga, um eco rápido viraria mensagem "externa"
// duplicada e o INSERT/UPDATE de quem enviou estouraria o UNIQUE. Só custa
// atraso para mensagem realmente externa, que ninguém está esperando.
const ATRASO_ASSENTAR_MS = 2500;

export function aguardarAssentarEco(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ATRASO_ASSENTAR_MS));
}

export interface AdotarEcoParams {
  supabase: SupabaseClient;
  /** "mensagens" (chat individual) ou "grupo_mensagens". */
  tabela: "mensagens" | "grupo_mensagens";
  /** Coluna que guarda o id da uazapi na tabela acima. */
  colunaMessageId: "zapi_message_id" | "uazapi_message_id";
  /** Escopo da busca: cliente (individual) ou grupo. */
  escopo: { coluna: "client_id" | "grupo_id"; valor: string };
  eco: EcoRecebido;
  /** Id da mensagem na uazapi, vindo do eco. */
  messageId: string;
}

/**
 * Tenta reconhecer o eco como uma mensagem que NÓS enviamos e que ainda não
 * recebeu o id da uazapi (corrida entre o eco e o UPDATE pós-envio).
 *
 * Sucesso → grava o id na NOSSA linha e devolve o id dela (nada de linha nova).
 * Nenhuma candidata → devolve null e o chamador registra como mensagem externa.
 */
export async function adotarEcoProprio(p: AdotarEcoParams): Promise<string | null> {
  const { supabase, tabela, colunaMessageId, escopo, eco, messageId } = p;
  const desde = new Date(Date.now() - JANELA_MS).toISOString();

  const { data, error } = await supabase
    .from(tabela)
    .select("id, tipo, content, media_metadata, created_at")
    .eq(escopo.coluna, escopo.valor)
    .eq("direction", "outbound")
    .neq("sender_type", "externo")
    // 'falha' fora: envio que falhou não gera eco, e adotá-lo marcaria como
    // enviada uma mensagem que o cliente nunca recebeu.
    .neq("status_envio", "falha")
    .is(colunaMessageId, null)
    .gte("created_at", desde)
    .order("created_at", { ascending: true })
    .limit(MAX_CANDIDATAS);

  if (error) {
    // Falhar aqui não pode derrubar o webhook: sem adoção o pior caso é uma
    // linha duplicada, com adoção quebrada seria mensagem perdida.
    log({
      funcao: FUNCAO,
      evento: "eco_busca_candidatas_erro",
      status: "erro",
      erro_msg: error.message,
      extra: { tabela },
    });
    return null;
  }

  const candidatas = candidatasParaAdocao((data ?? []) as CandidataEco[], eco);

  for (const c of candidatas) {
    // Condicional (`is null`): se outro eco concorrente adotou primeiro, esta
    // atualização não pega nada e seguimos para a próxima candidata.
    const { data: adotada } = await supabase
      .from(tabela)
      .update({ [colunaMessageId]: messageId, status_envio: "enviado" })
      .eq("id", c.id)
      .is(colunaMessageId, null)
      .select("id")
      .maybeSingle();

    if (adotada?.id) {
      log({
        funcao: FUNCAO,
        evento: "eco_proprio_adotado",
        status: "ok",
        mensagem_id: c.id,
        extra: { tabela, message_id: messageId, tipo: eco.tipo },
      });
      return c.id as string;
    }
  }

  return null;
}
