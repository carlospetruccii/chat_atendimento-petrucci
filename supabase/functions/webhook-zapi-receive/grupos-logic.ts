// Lógica pura das mensagens de grupo que chegam pelo webhook.
// Sem I/O — testada em grupos-logic.test.ts.

export interface IdentidadeGrupo {
  /** JID canônico do grupo: '<digitos>@g.us'. */
  jid: string;
  /** Quem falou dentro do grupo, em E.164. Null quando fromMe (fomos nós). */
  participanteNumero: string | null;
  /** Melhor rótulo disponível para o participante (pushName da uazapi). */
  participanteNome: string | null;
  /** Mensagem enviada pelo nosso próprio número (pelo celular da empresa). */
  fromMe: boolean;
}

function textoUtil(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Nome utilizável: descarta vazio e valores que são só telefone. */
function escolherNome(...vals: unknown[]): string | null {
  for (const v of vals) {
    const s = textoUtil(v);
    if (s && !/^\+?\d[\d\s()-]*$/.test(s)) return s;
  }
  return null;
}

function normalizarE164(raw: unknown): string | null {
  const s = textoUtil(raw);
  if (!s) return null;
  // Descarta LID: não é telefone e não cabe no CHECK de E.164.
  if (/@lid$/i.test(s)) return null;
  const digitos = s.split("@")[0].replace(/\D/g, "");
  // E.164: 8 a 15 dígitos, primeiro dígito do DDI não pode ser 0.
  if (digitos.length < 8 || digitos.length > 15 || digitos.startsWith("0")) return null;
  return `+${digitos}`;
}

export function normalizarJidGrupo(raw: unknown): string | null {
  const s = textoUtil(raw);
  if (!s || !/@g\.us$/i.test(s)) return null;
  const digitos = s.split("@")[0].replace(/\D/g, "");
  if (digitos.length < 5) return null;
  return `${digitos}@g.us`;
}

/**
 * Lê a identidade de grupo do payload da uazapi.
 *
 * O `chatid` é o grupo; o participante que falou vem em `sender`/`participant`/
 * `sender_pn` (o `sender` é o JID completo da pessoa, não do grupo). Retorna
 * null quando o payload não é de grupo ou não tem JID utilizável.
 *
 * Em `fromMe` o remetente é o nosso próprio número: não gravamos participante
 * (a mensagem é nossa, feita fora do sistema) e a bolha sai do lado direito.
 */
export function extrairIdentidadeGrupo(
  payload: Record<string, unknown>,
  envelope?: Record<string, unknown>,
): IdentidadeGrupo | null {
  const jid = normalizarJidGrupo(payload.chatid) ??
    normalizarJidGrupo((payload as { chatId?: unknown }).chatId) ??
    normalizarJidGrupo(envelope?.chatid);
  if (!jid) return null;

  const fromMe = payload.fromMe === true;

  if (fromMe) {
    return { jid, participanteNumero: null, participanteNome: null, fromMe: true };
  }

  const participanteNumero = normalizarE164(payload.sender_pn) ??
    normalizarE164(payload.sender) ??
    normalizarE164((payload as { participant?: unknown }).participant) ??
    normalizarE164((payload as { participantPn?: unknown }).participantPn);

  const chat = (envelope?.chat && typeof envelope.chat === "object")
    ? (envelope.chat as Record<string, unknown>)
    : {};

  const participanteNome = escolherNome(
    payload.senderName,
    (payload as { pushName?: unknown }).pushName,
    (payload as { senderPushName?: unknown }).senderPushName,
    (payload as { participantName?: unknown }).participantName,
    chat.pushName,
  );

  return { jid, participanteNumero, participanteNome, fromMe: false };
}

/** Nome do grupo, quando o webhook o traz junto (evita um /group/info à toa). */
export function extrairNomeGrupo(
  payload: Record<string, unknown>,
  envelope?: Record<string, unknown>,
): string | null {
  const chat = (envelope?.chat && typeof envelope.chat === "object")
    ? (envelope.chat as Record<string, unknown>)
    : {};
  return escolherNome(
    chat.wa_name,
    chat.name,
    chat.wa_contactName,
    payload.chatName,
    (payload as { groupName?: unknown }).groupName,
  );
}
