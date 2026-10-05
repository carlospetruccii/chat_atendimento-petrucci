// Decisões puras do backfill (sem banco e sem rede), para poder testar.
//
// `idsPossiveis` e `inteiroNoIntervalo` moraram aqui primeiro e hoje vivem em
// _shared/historico.ts: a importação de histórico antigo precisa EXATAMENTE da
// mesma leitura de id (as duas gravam em `mensagens` e uma tem que enxergar o
// que a outra gravou, senão duplica). Reexportados para não mudar os
// chamadores.
export { idsPossiveis, inteiroNoIntervalo } from "../_shared/historico.ts";

export interface PapelMensagem {
  direction: "inbound" | "outbound";
  sender_type: "cliente" | "externo";
  status_whatsapp: string | null;
}

/**
 * Papel da mensagem recuperada, a partir do `fromMe` da uazapi.
 *
 * `fromMe` = saiu do nosso número por fora do Chat (o outro sistema); o que não
 * é `fromMe` veio do cliente e entra exatamente como o webhook grava inbound —
 * inclusive `status_whatsapp` nulo, porque status de entrega só existe para o
 * que NÓS enviamos.
 */
export function papelDaMensagemBackfill(fromMe: boolean): PapelMensagem {
  return fromMe
    ? { direction: "outbound", sender_type: "externo", status_whatsapp: "enviado" }
    : { direction: "inbound", sender_type: "cliente", status_whatsapp: null };
}

/**
 * Se vale rodar a rede EXTRA anti-duplicata por janela de tempo.
 *
 * Ela existe para o outbound: o outro sistema pode ter gravado a mesma mensagem
 * com um formato de id diferente, e aí só o horário aproxima as duas. No inbound
 * o `zapi_message_id` sempre veio do webhook no mesmo formato `owner:messageid`
 * que a uazapi devolve — a janela só produz FALSO POSITIVO, porque cliente
 * mandando três mensagens seguidas em 20s viraria "duplicata" e seria descartado.
 */
export function usaJanelaDuplicata(direction: "inbound" | "outbound"): boolean {
  return direction === "outbound";
}
