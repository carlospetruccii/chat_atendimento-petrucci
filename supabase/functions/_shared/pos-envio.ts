// Gravação do id da uazapi na linha recém-enviada.
//
// Por que não é um UPDATE direto: o webhook agora recebe o eco dos envios
// feitos pela API (necessário para enxergar o que o outro sistema manda pela
// mesma instância). Se o eco chegar antes deste UPDATE e não for reconhecido
// como nosso, ele cria uma linha com aquele mesmo `message_id` — e o UNIQUE faz
// este UPDATE falhar. A mensagem SAIU; deixá-la presa em "enviando" seria o
// pior desfecho. Então, no conflito, gravamos só o status.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export interface ResultadoPosEnvio {
  ok: boolean;
  /** true = o id já estava em outra linha (eco); status foi gravado assim mesmo. */
  conflito: boolean;
  erro?: string;
}

export async function gravarIdPosEnvio(p: {
  supabase: SupabaseClient;
  tabela: "mensagens" | "grupo_mensagens";
  colunaMessageId: "zapi_message_id" | "uazapi_message_id";
  mensagemId: string;
  messageId: string | null;
}): Promise<ResultadoPosEnvio> {
  const { supabase, tabela, colunaMessageId, mensagemId, messageId } = p;

  const { error } = await supabase
    .from(tabela)
    .update({ status_envio: "enviado", [colunaMessageId]: messageId })
    .eq("id", mensagemId);

  if (!error) return { ok: true, conflito: false };

  const ehUnique = error.code === "23505" || /duplicate key/i.test(error.message);
  if (!ehUnique) return { ok: false, conflito: false, erro: error.message };

  const { error: errStatus } = await supabase
    .from(tabela)
    .update({ status_envio: "enviado" })
    .eq("id", mensagemId);

  return errStatus
    ? { ok: false, conflito: true, erro: errStatus.message }
    : { ok: true, conflito: true };
}
