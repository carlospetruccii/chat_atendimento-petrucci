// Cliente da Google People API — usado pela função google-contacts para
// conectar a conta Google (OAuth) e sincronizar a agenda de contatos.
//
// Secrets lidos (nunca vão ao frontend):
//   - GOOGLE_CLIENT_ID     (ID do cliente OAuth — você fornece)
//   - GOOGLE_CLIENT_SECRET (segredo do cliente OAuth — você fornece)
//
// Escopo usado: contacts.readonly (só leitura dos contatos).

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const PEOPLE_CONNECTIONS_URL =
  "https://people.googleapis.com/v1/people/me/connections";

export const GOOGLE_SCOPE =
  "https://www.googleapis.com/auth/contacts.readonly openid email";

export class GoogleError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "GoogleError";
    this.status = status;
    this.body = body;
  }
}

export function googleConfigurado(): boolean {
  return Boolean(
    Deno.env.get("GOOGLE_CLIENT_ID") && Deno.env.get("GOOGLE_CLIENT_SECRET"),
  );
}

function getClientId(): string {
  const v = Deno.env.get("GOOGLE_CLIENT_ID");
  if (!v) throw new Error("Secret GOOGLE_CLIENT_ID ausente.");
  return v;
}

function getClientSecret(): string {
  const v = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!v) throw new Error("Secret GOOGLE_CLIENT_SECRET ausente.");
  return v;
}

// Monta a URL de consentimento do Google. `state` carrega para onde voltar.
export function montarAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline", // pede refresh_token
    prompt: "consent", // garante refresh_token mesmo em reconexão
    include_granted_scopes: "true",
    state,
  });
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

export interface TokenResp {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // segundos
  scope?: string;
  token_type?: string;
}

// Troca o `code` do callback por tokens (inclui refresh_token na 1ª vez).
export async function trocarCodePorToken(
  code: string,
  redirectUri: string,
): Promise<TokenResp> {
  const body = new URLSearchParams({
    code,
    client_id: getClientId(),
    client_secret: getClientSecret(),
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const txt = await res.text();
  if (!res.ok) throw new GoogleError("falha ao trocar code", res.status, txt.slice(0, 300));
  return JSON.parse(txt) as TokenResp;
}

// Renova o access_token a partir do refresh_token.
export async function renovarAccessToken(refreshToken: string): Promise<TokenResp> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: getClientId(),
    client_secret: getClientSecret(),
    grant_type: "refresh_token",
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const txt = await res.text();
  if (!res.ok) throw new GoogleError("falha ao renovar token", res.status, txt.slice(0, 300));
  return JSON.parse(txt) as TokenResp;
}

// Revoga o acesso (usado no desconectar).
export async function revogarToken(token: string): Promise<void> {
  try {
    await fetch(`${OAUTH_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } catch {
    // Revogação é best-effort; se falhar apenas limpamos localmente.
  }
}

// Descobre o e-mail da conta conectada (para exibir "conectado como ...").
export async function buscarEmailConta(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { email?: string };
    return typeof j.email === "string" ? j.email : null;
  } catch {
    return null;
  }
}

export interface PessoaContato {
  resourceName: string;
  etag: string;
  nome: string | null;
  numeroE164: string | null;
  numeroRaw: string | null;
  emails: string[];
  deleted: boolean;
}

interface ConnectionsPage {
  contatos: PessoaContato[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

// Normaliza um telefone para E.164 ('+' + dígitos). Estratégia:
//   - Se vier canonicalForm da People API (já E.164), usa direto.
//   - Se o texto começa com '+', usa os dígitos.
//   - Sem DDI e com 10-11 dígitos (padrão BR local), assume Brasil (+55).
//   - >= 12 dígitos → assume que já traz DDI, só prefixa '+'.
//   - Caso contrário, retorna null (fica só o numero_raw).
export function normalizarTelefone(
  canonical: string | null,
  valor: string | null,
): string | null {
  if (canonical && /^\+[1-9]\d{7,14}$/.test(canonical)) return canonical;
  const bruto = (valor ?? canonical ?? "").trim();
  if (!bruto) return null;
  const temMais = bruto.startsWith("+");
  const digitos = bruto.replace(/\D/g, "");
  if (!digitos) return null;
  if (temMais) {
    return /^[1-9]\d{7,14}$/.test(digitos) ? `+${digitos}` : null;
  }
  if (digitos.length === 10 || digitos.length === 11) {
    // BR local (com ou sem o 9): assume +55.
    return `+55${digitos}`;
  }
  if (digitos.length >= 12 && digitos.length <= 15) {
    return `+${digitos}`;
  }
  return null;
}

interface RawPerson {
  resourceName?: string;
  etag?: string;
  metadata?: { deleted?: boolean };
  names?: Array<{ displayName?: string }>;
  phoneNumbers?: Array<{ value?: string; canonicalForm?: string }>;
  emailAddresses?: Array<{ value?: string }>;
}

function mapPerson(p: RawPerson): PessoaContato {
  const nome = p.names?.find((n) => n.displayName)?.displayName ?? null;
  const tel = p.phoneNumbers?.[0];
  const numeroRaw = tel?.value ?? tel?.canonicalForm ?? null;
  const numeroE164 = normalizarTelefone(tel?.canonicalForm ?? null, tel?.value ?? null);
  const emails = (p.emailAddresses ?? [])
    .map((e) => e.value)
    .filter((e): e is string => typeof e === "string");
  return {
    resourceName: p.resourceName ?? "",
    etag: p.etag ?? "",
    nome,
    numeroE164,
    numeroRaw,
    emails,
    deleted: p.metadata?.deleted === true,
  };
}

// Lê uma página de contatos. `syncToken` faz sincronização incremental;
// `pageToken` pagina. Retorna também o próximo syncToken (na última página).
export async function listarConexoes(params: {
  accessToken: string;
  pageToken?: string | null;
  syncToken?: string | null;
}): Promise<ConnectionsPage> {
  const q = new URLSearchParams({
    personFields: "names,phoneNumbers,emailAddresses,metadata",
    pageSize: "1000",
    requestSyncToken: "true",
  });
  if (params.pageToken) q.set("pageToken", params.pageToken);
  if (params.syncToken) q.set("syncToken", params.syncToken);

  const res = await fetch(`${PEOPLE_CONNECTIONS_URL}?${q.toString()}`, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  const txt = await res.text();
  if (!res.ok) {
    // 410 GONE = syncToken expirado → chamador deve refazer full sync.
    throw new GoogleError(`people.connections ${res.status}`, res.status, txt.slice(0, 300));
  }
  const j = JSON.parse(txt) as {
    connections?: RawPerson[];
    nextPageToken?: string;
    nextSyncToken?: string;
  };
  return {
    contatos: (j.connections ?? []).map(mapPerson),
    nextPageToken: j.nextPageToken ?? null,
    nextSyncToken: j.nextSyncToken ?? null,
  };
}
