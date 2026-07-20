// Cliente HTTP da uazapi (WhatsApp) — substitui o antigo zapi-client.
// Lê secrets: UAZAPI_URL (ex: https://SEU-SUBDOMINIO.uazapi.com) e UAZAPI_TOKEN
// (token da instância). Endpoints administrativos usam UAZAPI_ADMIN_TOKEN.
//
// Contrato confirmado na doc oficial (docs.uazapi.com, OpenAPI v2.0.1):
//   - Auth: header `token: <instance_token>` (ou `admintoken` para admin).
//   - Número: apenas dígitos, sem '+', sem espaços (ex: "5511999998888").
//   - Enviar texto:  POST /send/text   { number, text, replyid? }
//   - Enviar mídia:  POST /send/media  { number, type, file(URL|base64), text?, docName? }
//                    type ∈ image|video|document|audio|ptt|ptv|sticker|myaudio
//                    (nota de voz = "ptt")
//   - Menu/lista:    POST /send/menu   { number, type:"list", text, listButton, choices[] }
//                    choices: "[Seção]" abre seção; "texto|id|descrição" é um item.
//   - Apagar:        POST /message/delete { id }              (id = owner:messageid)
//   - Baixar mídia:  POST /message/download { id, return_base64? }
//   - Conectar:      POST /instance/connect  { phone? }  → { instance:{ qrcode }, ... }
//   - Status:        GET  /instance/status              → { status:{ connected, loggedIn } }
//   - Desconectar:   POST /instance/disconnect
//   - Webhook:       POST /webhook { url, events[], excludeMessages[] }
//
// SECURITY: nunca expor o token ao frontend. Roda apenas em Edge Functions.
//
// Mantém os MESMOS nomes/assinaturas de função do antigo zapi-client
// (enviarTexto, enviarMidia, enviarListaOpcoes, deletarMensagem) para que os
// chamadores mudem apenas o caminho do import. O nome de coluna zapi_message_id
// no banco continua (cosmético) e passa a guardar o `id` da uazapi.

const MAX_TENTATIVAS = 3;
// Timeout por requisição — evita que uma conexão pendurada na uazapi trave a
// Edge Function (ex.: o loop do cron de alertas) indefinidamente.
const REQUEST_TIMEOUT_MS = 20_000;

function getBaseUrl(): string {
  const url = Deno.env.get("UAZAPI_URL");
  if (!url) throw new Error("Secret UAZAPI_URL ausente.");
  return url.replace(/\/+$/, "");
}

function getToken(): string {
  const token = Deno.env.get("UAZAPI_TOKEN");
  if (!token) throw new Error("Secret UAZAPI_TOKEN ausente.");
  return token;
}

function getAdminToken(): string {
  const token = Deno.env.get("UAZAPI_ADMIN_TOKEN");
  if (!token) throw new Error("Secret UAZAPI_ADMIN_TOKEN ausente.");
  return token;
}

// Mantém o nome ZapiError por compatibilidade com os chamadores; alias claro abaixo.
export class UazapiError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "UazapiError";
    this.status = status;
    this.body = body;
  }
}
export { UazapiError as ZapiError };

// Normaliza número para dígitos puros (uazapi rejeita '+', espaços, traços).
function soDigitos(telefone: string): string {
  return telefone.replace(/\D/g, "");
}

type MetodoHttp = "GET" | "POST" | "DELETE";

async function chamar(
  metodo: MetodoHttp,
  endpoint: string,
  payload?: unknown,
  opts?: { admin?: boolean },
): Promise<unknown> {
  const url = `${getBaseUrl()}${endpoint}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (opts?.admin) headers.admintoken = getAdminToken();
  else headers.token = getToken();

  let ultimoErro: UazapiError | null = null;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: metodo,
        headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (resp.ok) {
      const texto = await resp.text();
      try {
        return texto ? JSON.parse(texto) : {};
      } catch {
        return { raw: texto };
      }
    }

    const corpo = await resp.text();

    // 429 = limite da instância; backoff crescente 1s, 3s, 9s.
    if (resp.status === 429 && tentativa < MAX_TENTATIVAS) {
      const esperaMs = Math.pow(3, tentativa - 1) * 1000;
      ultimoErro = new UazapiError(
        `uazapi rate limit (429), tentativa ${tentativa}/${MAX_TENTATIVAS}`,
        resp.status,
        corpo,
      );
      await new Promise((r) => setTimeout(r, esperaMs));
      continue;
    }

    throw new UazapiError(
      `uazapi erro HTTP ${resp.status} em ${metodo} ${endpoint}`,
      resp.status,
      corpo,
    );
  }

  throw ultimoErro ?? new UazapiError("uazapi rate limit esgotou retries", 429, "");
}

// ————————————————————————————————————————————————————————————————
// ENVIO
// ————————————————————————————————————————————————————————————————

export interface EnviarTextoParams {
  // Número em dígitos (aceita com/sem '+', normaliza internamente).
  telefone: string;
  mensagem: string;
  // `id` (owner:messageid) da mensagem citada para responder.
  quotedZapiMessageId?: string;
}

export async function enviarTexto(params: EnviarTextoParams): Promise<unknown> {
  const payload: Record<string, unknown> = {
    number: soDigitos(params.telefone),
    text: params.mensagem,
  };
  if (params.quotedZapiMessageId) payload.replyid = params.quotedZapiMessageId;
  return await chamar("POST", "/send/text", payload);
}

// Tipos internos do sistema (mesma enum de antes). audio = nota de voz → "ptt".
export type TipoMidia = "image" | "audio" | "video" | "document";

const MAPA_TIPO_UAZAPI: Record<TipoMidia, string> = {
  image: "image",
  audio: "ptt", // nota de voz
  video: "video",
  document: "document",
};

export interface EnviarMidiaParams {
  telefone: string;
  tipo: TipoMidia;
  // URL pública (assinada) da mídia OU base64. Preferir URL.
  url: string;
  caption?: string;
  // Nome do arquivo (usado em document → docName).
  fileName?: string;
  // Compat: extensão (não usada pela uazapi, mantida na assinatura).
  extension?: string;
  quotedZapiMessageId?: string;
}

export async function enviarMidia(params: EnviarMidiaParams): Promise<unknown> {
  const payload: Record<string, unknown> = {
    number: soDigitos(params.telefone),
    type: MAPA_TIPO_UAZAPI[params.tipo],
    file: params.url,
  };
  if (params.caption) payload.text = params.caption;
  if (params.tipo === "document" && params.fileName) payload.docName = params.fileName;
  if (params.quotedZapiMessageId) payload.replyid = params.quotedZapiMessageId;
  return await chamar("POST", "/send/media", payload);
}

export interface OpcaoLista {
  // ID estável da opção — volta em `buttonOrListid` quando o cliente escolhe.
  id: string;
  // Texto principal da opção.
  title: string;
  // Texto secundário, opcional.
  description?: string;
}

export interface EnviarListaOpcoesParams {
  telefone: string;
  // Corpo da mensagem (texto principal acima do botão).
  mensagem: string;
  // Cabeçalho/legenda da lista — vira o rodapé (footerText) na uazapi.
  tituloLista: string;
  // Rótulo do botão que abre a lista (ex: "Ver setores").
  buttonLabel: string;
  // 2 a 10 opções.
  opcoes: OpcaoLista[];
}

/**
 * Envia menu interativo tipo "list" via uazapi (POST /send/menu).
 * choices no formato "texto|id|descrição". Quando o cliente escolhe, a uazapi
 * entrega no webhook o `buttonOrListid` = id da opção (e o texto em `text`).
 */
export async function enviarListaOpcoes(params: EnviarListaOpcoesParams): Promise<unknown> {
  const choices = params.opcoes.map((o) => {
    const partes = [o.title, o.id];
    if (o.description) partes.push(o.description);
    return partes.join("|");
  });
  const payload: Record<string, unknown> = {
    number: soDigitos(params.telefone),
    type: "list",
    text: params.mensagem,
    listButton: params.buttonLabel,
    choices,
  };
  if (params.tituloLista) payload.footerText = params.tituloLista;
  return await chamar("POST", "/send/menu", payload);
}

export interface DeletarMensagemParams {
  // Compat: telefone (não usado pela uazapi; delete é por `id`).
  telefone?: string;
  // `id` completo (owner:messageid) — guardado em mensagens.zapi_message_id.
  zapiMessageId: string;
}

export async function deletarMensagem(params: DeletarMensagemParams): Promise<unknown> {
  return await chamar("POST", "/message/delete", { id: params.zapiMessageId });
}

// Extrai o id (owner:messageid) da resposta de envio da uazapi.
// A resposta de /send/* é um objeto Message (id no topo).
export function extrairMessageId(resposta: unknown): string | null {
  const r = resposta as { id?: string; messageid?: string } | null;
  return r?.id ?? r?.messageid ?? null;
}

// ————————————————————————————————————————————————————————————————
// MÍDIA RECEBIDA
// ————————————————————————————————————————————————————————————————

export interface BaixarMidiaResult {
  base64?: string;
  mimetype?: string;
  fileName?: string;
  url?: string;
}

/**
 * Baixa o arquivo de uma mensagem recebida (POST /message/download).
 * return_base64=true retorna o conteúdo em base64 para persistir no bucket.
 */
export async function baixarMidiaMensagem(id: string): Promise<BaixarMidiaResult> {
  const resp = (await chamar("POST", "/message/download", {
    id,
    return_base64: true,
  })) as Record<string, unknown>;
  return {
    base64: (resp.base64Data ?? resp.base64 ?? resp.fileBase64 ?? resp.data) as string | undefined,
    mimetype: (resp.mimetype ?? resp.mimeType) as string | undefined,
    fileName: (resp.fileName ?? resp.filename) as string | undefined,
    url: (resp.fileURL ?? resp.url ?? resp.link) as string | undefined,
  };
}

// ————————————————————————————————————————————————————————————————
// INSTÂNCIA (conexão / QR / status) — usado pela tela de conexão
// ————————————————————————————————————————————————————————————————

export interface ConnectResult {
  connected: boolean;
  loggedIn: boolean;
  qrcode?: string; // base64 PNG (quando desconectado, sem phone)
  paircode?: string; // código de pareamento (quando phone informado)
  raw: unknown;
}

/**
 * Inicia a conexão da instância. Sem `phone`, retorna QR code (base64 PNG)
 * para escanear. Com `phone`, retorna código de pareamento.
 */
export async function conectarInstancia(phone?: string): Promise<ConnectResult> {
  const payload = phone ? { phone: soDigitos(phone) } : {};
  const resp = (await chamar("POST", "/instance/connect", payload)) as Record<string, unknown>;
  const instance = (resp.instance ?? {}) as Record<string, unknown>;
  return {
    connected: Boolean(resp.connected),
    loggedIn: Boolean(resp.loggedIn),
    qrcode: (instance.qrcode ?? resp.qrcode) as string | undefined,
    paircode: (instance.paircode ?? resp.paircode) as string | undefined,
    raw: resp,
  };
}

export interface StatusResult {
  connected: boolean;
  loggedIn: boolean;
  status?: string; // texto: "connected" | "connecting" | "disconnected" | ...
  profileName?: string;
  numero?: string; // número conectado (jid.user), se logado
  raw: unknown;
}

export async function statusInstancia(): Promise<StatusResult> {
  const resp = (await chamar("GET", "/instance/status")) as Record<string, unknown>;
  const st = (resp.status ?? {}) as Record<string, unknown>;
  const inst = (resp.instance ?? {}) as Record<string, unknown>;
  const jid = (st.jid ?? {}) as Record<string, unknown>;
  return {
    connected: Boolean(st.connected),
    loggedIn: Boolean(st.loggedIn),
    status: (inst.status ?? st.status) as string | undefined,
    profileName: inst.profileName as string | undefined,
    numero: jid.user as string | undefined,
    raw: resp,
  };
}

export async function desconectarInstancia(): Promise<unknown> {
  return await chamar("POST", "/instance/disconnect");
}

// ————————————————————————————————————————————————————————————————
// WEBHOOK (configuração)
// ————————————————————————————————————————————————————————————————

export interface ConfigurarWebhookParams {
  url: string;
  // Padrão: novas mensagens, status de mensagem e conexão.
  events?: string[];
  // Evita loop: não recebe de volta o que a própria API enviou.
  excludeMessages?: string[];
  enabled?: boolean;
}

export async function configurarWebhook(params: ConfigurarWebhookParams): Promise<unknown> {
  const payload = {
    url: params.url,
    events: params.events ?? ["messages", "messages_update", "connection"],
    excludeMessages: params.excludeMessages ?? ["wasSentByApi"],
    enabled: params.enabled ?? true,
  };
  return await chamar("POST", "/webhook", payload);
}

export async function verWebhook(): Promise<unknown> {
  return await chamar("GET", "/webhook");
}

// ————————————————————————————————————————————————————————————————
// MARCAR COMO LIDO (confirmação de leitura / "tique azul")
// ————————————————————————————————————————————————————————————————

// Marca o chat inteiro como lido no WhatsApp — POST /chat/read.
// Isso zera o contador de não lidas E dispara a confirmação de leitura
// (o "tique azul") para o remetente, DESDE QUE a conta conectada esteja com
// "confirmações de leitura" habilitado nas configurações do WhatsApp.
// Endpoint de chat aceita número em dígitos puros (mesmo padrão de /chat/details).
export async function marcarChatComoLido(telefone: string): Promise<unknown> {
  return await chamar("POST", "/chat/read", {
    number: soDigitos(telefone),
    read: true,
  });
}

// ————————————————————————————————————————————————————————————————
// CONTATO (nome / detalhes do chat)
// ————————————————————————————————————————————————————————————————

// Busca o nome do contato via POST /chat/details. Usado quando iniciamos uma
// conversa pelo celular (fromMe): o webhook não traz o nome do destinatário,
// mas este endpoint devolve o pushname/nome salvo. Retorna null se não houver
// nome utilizável (ignora vazio e valores puramente numéricos = telefone).
export async function buscarNomeContato(numero: string): Promise<string | null> {
  try {
    const r = (await chamar("POST", "/chat/details", {
      number: soDigitos(numero),
    })) as Record<string, unknown>;
    const candidatos = [r.name, r.wa_name, r.wa_contactName, r.lead_fullName, r.lead_name];
    for (const v of candidatos) {
      if (typeof v === "string" && v.trim() && !/^\+?\d[\d\s-]*$/.test(v.trim())) {
        return v.trim();
      }
    }
  } catch {
    // best-effort: sem nome não é erro fatal
  }
  return null;
}
