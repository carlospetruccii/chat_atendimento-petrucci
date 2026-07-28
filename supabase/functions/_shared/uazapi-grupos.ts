// Tradução do objeto Group da uazapi para o nosso shape de `grupos`.
//
// O schema oficial (OpenAPI v2.0.1, componente Group) usa PascalCase:
//   JID, Name, Topic, Participants[], IsAnnounce, OwnerIsAdmin,
//   OwnerCanSendMessage — "Owner" aqui é a instância conectada (nós).
// Como já aconteceu com o parse de mensagem, os nomes exatos que a instância
// devolve variam, então cada campo é lido por uma LISTA de candidatos
// (PascalCase oficial → camelCase → snake_case → prefixo wa_*).
//
// Mantido puro e sem I/O de propósito: é o pedaço com mais chance de errar e o
// único que dá para testar sem uma instância real (ver uazapi-grupos.test.ts).

export interface GrupoUazapi {
  /** JID do grupo, ex: '120363012345678901@g.us'. */
  jid: string;
  nome: string | null;
  topico: string | null;
  fotoUrl: string | null;
  participantesTotal: number | null;
  /** Nosso número é administrador do grupo? */
  souAdmin: boolean;
  /** Grupo em modo "somente admins enviam" (announce). */
  somenteAdminEnvia: boolean;
}

function primeiroTexto(
  obj: Record<string, unknown>,
  chaves: readonly string[],
): string | null {
  for (const k of chaves) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

function primeiroBooleano(
  obj: Record<string, unknown>,
  chaves: readonly string[],
): boolean | null {
  for (const k of chaves) {
    const v = obj[k];
    if (typeof v === "boolean") return v;
  }
  return null;
}

/** Normaliza para o JID canônico '<digitos>@g.us'; null se não parecer grupo. */
export function normalizarJidGrupo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "") return null;
  const digitos = s.split("@")[0].replace(/\D/g, "");
  if (digitos.length < 5) return null;
  // Aceita tanto '123@g.us' quanto '123' (algumas rotas devolvem o id cru).
  if (s.includes("@") && !/@g\.us$/i.test(s)) return null;
  return `${digitos}@g.us`;
}

/**
 * Converte um item do GET /group/list (ou do POST /group/info) no nosso shape.
 * Retorna null quando não há JID de grupo utilizável — item inválido é
 * descartado em vez de virar linha suja no banco.
 */
export function mapearGrupoUazapi(bruto: unknown): GrupoUazapi | null {
  if (!bruto || typeof bruto !== "object") return null;
  const g = bruto as Record<string, unknown>;

  const jid = normalizarJidGrupo(
    primeiroTexto(g, ["JID", "jid", "id", "chatid", "wa_chatid", "GroupJID", "groupJid"]),
  );
  if (!jid) return null;

  const nome = primeiroTexto(g, ["Name", "name", "subject", "GroupName", "wa_name", "wa_contactName"]);
  const topico = primeiroTexto(g, ["Topic", "topic", "description", "desc"]);
  const fotoUrl = primeiroTexto(g, ["imgUrl", "ImgUrl", "profilePicUrl", "picture", "image", "wa_profilePicUrl"]);

  const participantes = g.Participants ?? g.participants ?? g.members;
  const participantesTotal = Array.isArray(participantes)
    ? participantes.length
    : typeof g.participantsCount === "number"
      ? (g.participantsCount as number)
      : typeof g.size === "number"
        ? (g.size as number)
        : null;

  const somenteAdminEnvia = primeiroBooleano(g, [
    "IsAnnounce",
    "isAnnounce",
    "announce",
    "wa_isGroup_announce",
  ]) ?? false;

  // Somos admin se a API disser explicitamente. `OwnerCanSendMessage` só serve
  // como sinal indireto: num grupo em announce, poder enviar implica ser admin.
  const adminExplicito = primeiroBooleano(g, [
    "OwnerIsAdmin",
    "ownerIsAdmin",
    "isAdmin",
    "IsAdmin",
    "wa_isGroup_admin",
  ]);
  const podeEnviar = primeiroBooleano(g, ["OwnerCanSendMessage", "ownerCanSendMessage"]);
  const souAdmin = adminExplicito ?? (somenteAdminEnvia && podeEnviar === true);

  return { jid, nome, topico, fotoUrl, participantesTotal, souAdmin, somenteAdminEnvia };
}

export interface ParticipanteGrupoUazapi {
  /** Número em dígitos (sem @s.whatsapp.net), ex: '5511999998888'. */
  numero: string;
  /**
   * Nome via DisplayName — só a uazapi preenche isso para usuário anônimo;
   * na maioria dos casos vem null e o nome real é resolvido cruzando com a
   * agenda de contatos no frontend.
   */
  nome: string | null;
}

/** Converte um item de `Participants[]` (schema GroupParticipant) no nosso shape. */
function mapearParticipante(bruto: unknown): ParticipanteGrupoUazapi | null {
  if (!bruto || typeof bruto !== "object") return null;
  const p = bruto as Record<string, unknown>;
  const numero = primeiroTexto(p, ["PhoneNumber", "phoneNumber", "JID", "jid", "LID", "lid"])
    ?.split("@")[0]
    .replace(/\D/g, "");
  if (!numero) return null;
  const nome = primeiroTexto(p, [
    "DisplayName",
    "displayName",
    "Name",
    "name",
    "PushName",
    "pushName",
  ]);
  return { numero, nome };
}

/**
 * Extrai os participantes de uma resposta do POST /group/info. A rota pode
 * devolver o Group cru ou dentro de um envelope ({ group: {...} } / { data: {...} }).
 * Itens sem número utilizável e números repetidos são descartados.
 */
export function extrairParticipantesDaResposta(resposta: unknown): ParticipanteGrupoUazapi[] {
  if (!resposta || typeof resposta !== "object") return [];
  const raiz = resposta as Record<string, unknown>;
  const grupo =
    raiz.Participants || raiz.participants || raiz.members
      ? raiz
      : ((raiz.group ?? raiz.Group ?? raiz.data ?? {}) as Record<string, unknown>);

  const participantes = grupo.Participants ?? grupo.participants ?? grupo.members;
  if (!Array.isArray(participantes)) return [];

  const porNumero = new Map<string, ParticipanteGrupoUazapi>();
  for (const item of participantes) {
    const p = mapearParticipante(item);
    if (p && !porNumero.has(p.numero)) porNumero.set(p.numero, p);
  }
  return Array.from(porNumero.values());
}

/**
 * Extrai a lista de grupos de uma resposta do GET /group/list. A rota pode
 * devolver um array cru ou um envelope ({ groups: [...] } / { data: [...] }).
 * Itens inválidos e JIDs repetidos são descartados.
 */
export function extrairGruposDaResposta(resposta: unknown): GrupoUazapi[] {
  const candidatos: unknown = Array.isArray(resposta)
    ? resposta
    : resposta && typeof resposta === "object"
      ? ((resposta as Record<string, unknown>).groups ??
        (resposta as Record<string, unknown>).Groups ??
        (resposta as Record<string, unknown>).data ??
        (resposta as Record<string, unknown>).chats ??
        [])
      : [];

  if (!Array.isArray(candidatos)) return [];

  const porJid = new Map<string, GrupoUazapi>();
  for (const item of candidatos) {
    const g = mapearGrupoUazapi(item);
    if (g && !porJid.has(g.jid)) porJid.set(g.jid, g);
  }
  return Array.from(porJid.values());
}
