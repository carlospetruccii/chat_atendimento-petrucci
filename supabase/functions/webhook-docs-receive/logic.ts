// Decisões puras do webhook do Docs (sem banco, testadas em logic.test.ts).
// Espelham as regras do webhook-zapi-receive — o formato do envelope da uazapi
// é o mesmo nas duas instâncias.

import { normalizarJidGrupo } from "../webhook-zapi-receive/grupos-logic.ts";

export type StatusWhatsapp = "enviado" | "entregue" | "lido" | "falha_whatsapp";
export type OrigemExterna = "api_externa" | "celular" | "desconhecida";

export interface EventoClassificado {
  rota: "conexao" | "status" | "mensagem" | "desconhecido";
  evento: string | null;
  payload: Record<string, unknown>;
  statusRaw: string | null;
  fromMe: boolean;
  wasSentByApi: boolean;
  messageId: string | null;
  quotedId: string | null;
  ehGrupo: boolean;
}

/**
 * Formato REAL da uazapi (confirmado em produção no número principal):
 *   { EventType, chat, message, owner, token, instanceName, ... }
 * Mesma detecção defensiva do webhook principal: pelo nome do evento e, se ele
 * não bater, pela cara do payload.
 */
export function classificarEvento(envelope: Record<string, unknown>): EventoClassificado {
  const evento = ((envelope.EventType ?? envelope.event) as string | undefined) ?? null;
  const payload = ((envelope.message && typeof envelope.message === "object")
    ? envelope.message
    : (envelope.data && typeof envelope.data === "object")
    ? envelope.data
    : envelope) as Record<string, unknown>;

  const eventLc = (evento ?? "").toLowerCase();
  const statusRaw = (payload.status as string | undefined) ??
    (payload.messageStatus as string | undefined) ?? null;
  const temCaraDeMensagem = payload.messageType != null ||
    typeof payload.text === "string" ||
    payload.chatid != null ||
    payload.fromMe != null;
  const ehStatus = eventLc === "messages_update" || eventLc === "status" ||
    (!eventLc.startsWith("message") && !temCaraDeMensagem && statusRaw != null);
  const ehMensagem = eventLc === "messages" || eventLc === "message" ||
    (!ehStatus && temCaraDeMensagem);

  const rota: EventoClassificado["rota"] = eventLc === "connection"
    ? "conexao"
    : ehStatus
    ? "status"
    : ehMensagem
    ? "mensagem"
    : "desconhecido";

  const messageId = (payload.id as string | undefined) ??
    (payload.messageid as string | undefined) ?? null;
  const quotedId = typeof payload.quoted === "string" && payload.quoted ? payload.quoted : null;
  const ehGrupo = normalizarJidGrupo(payload.chatid) !== null ||
    normalizarJidGrupo((payload as { chatId?: unknown }).chatId) !== null ||
    normalizarJidGrupo(envelope.chatid) !== null;

  return {
    rota,
    evento,
    payload,
    statusRaw,
    fromMe: payload.fromMe === true,
    wasSentByApi: payload.wasSentByApi === true,
    messageId,
    quotedId,
    ehGrupo,
  };
}

/**
 * Quem mandou uma mensagem que saiu do número financeiro por fora do sistema.
 * Tri-estado, igual ao webhook principal: `origem` virou autorização (só
 * 'celular' pode ser apagado para todos), então ausente NÃO pode virar 'celular'.
 */
export function origemExterna(wasSentByApiBruto: unknown): OrigemExterna {
  if (wasSentByApiBruto === true) return "api_externa";
  if (wasSentByApiBruto === false) return "celular";
  return "desconhecida";
}

/** Primeiro nome utilizável; ignora vazio e valor que é só telefone. */
export function escolherNomeContato(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() && !/^\+?\d[\d\s-]*$/.test(v.trim())) {
      return v.trim();
    }
  }
  return null;
}

/** Status string da uazapi → enum status_whatsapp_mensagem (por substring). */
export function mapStatusWhatsapp(s: string | undefined | null): StatusWhatsapp | null {
  if (!s) return null;
  const u = String(s).toUpperCase();
  if (u.includes("DELIVER")) return "entregue";
  if (u.includes("READ") || u.includes("PLAYED")) return "lido";
  if (u.includes("SENT")) return "enviado";
  if (u.includes("FAIL") || u.includes("ERROR")) return "falha_whatsapp";
  return null;
}
