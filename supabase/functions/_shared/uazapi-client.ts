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

import {
  extrairGruposDaResposta,
  extrairParticipantesDaResposta,
  type GrupoUazapi,
  mapearGrupoUazapi,
  type ParticipanteGrupoUazapi,
} from "./uazapi-grupos.ts";
import { fotoDoChat, lerFotoGrupo } from "./foto-perfil.ts";

export type { GrupoUazapi, ParticipanteGrupoUazapi };

const MAX_TENTATIVAS = 3;
// Timeout por requisição — evita que uma conexão pendurada na uazapi trave a
// Edge Function (ex.: o loop do cron de alertas) indefinidamente.
const REQUEST_TIMEOUT_MS = 20_000;
// /group/info para foto (pode ir ao WhatsApp): lenta, ganha folga própria.
const TIMEOUT_FOTO_GRUPO_MS = 60_000;

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

/** Um destino é grupo quando termina em '@g.us' (JID de grupo do WhatsApp). */
export function ehJidGrupo(destino: string): boolean {
  return /@g\.us$/i.test(destino.trim());
}

// Destino de envio: número de pessoa vira dígitos puros; JID de grupo passa
// INTACTO. Rodar soDigitos num JID comeria o sufixo '@g.us' e a mensagem iria
// para um número inexistente em vez do grupo.
function normalizarDestino(destino: string): string {
  const d = destino.trim();
  return ehJidGrupo(d) ? d : soDigitos(d);
}

type MetodoHttp = "GET" | "POST" | "DELETE";

async function chamar(
  metodo: MetodoHttp,
  endpoint: string,
  payload?: unknown,
  opts?: { admin?: boolean; timeoutMs?: number },
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
    const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? REQUEST_TIMEOUT_MS);
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
  // Número em dígitos (aceita com/sem '+', normaliza internamente) OU JID de
  // grupo ('...@g.us'), que é enviado sem normalização.
  telefone: string;
  mensagem: string;
  // `id` (owner:messageid) da mensagem citada para responder.
  quotedZapiMessageId?: string;
}

export async function enviarTexto(params: EnviarTextoParams): Promise<unknown> {
  const payload: Record<string, unknown> = {
    number: normalizarDestino(params.telefone),
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
    number: normalizarDestino(params.telefone),
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

/**
 * Extrai o número (só dígitos) do JID da instância. A rota devolve `status.jid`
 * como STRING no formato "5519991351061:7@s.whatsapp.net" — o ":7" é o id do
 * dispositivo e tem que sair. Aceita também o formato objeto ({ user }), que é
 * o que a doc sugere, e `instance.owner`, que já vem em dígitos puros.
 */
export function numeroDoJidInstancia(bruto: unknown): string | undefined {
  if (typeof bruto === "string") {
    const digitos = bruto.split("@")[0].split(":")[0].replace(/\D/g, "");
    return digitos || undefined;
  }
  if (bruto && typeof bruto === "object") {
    const user = (bruto as Record<string, unknown>).user;
    if (typeof user === "string") return user.replace(/\D/g, "") || undefined;
  }
  return undefined;
}

export async function statusInstancia(): Promise<StatusResult> {
  const resp = (await chamar("GET", "/instance/status")) as Record<string, unknown>;
  const st = (resp.status ?? {}) as Record<string, unknown>;
  const inst = (resp.instance ?? {}) as Record<string, unknown>;
  return {
    connected: Boolean(st.connected),
    loggedIn: Boolean(st.loggedIn),
    status: (inst.status ?? st.status) as string | undefined,
    profileName: inst.profileName as string | undefined,
    numero: numeroDoJidInstancia(st.jid) ?? numeroDoJidInstancia(inst.owner),
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
  // Filtro na origem. Fica VAZIO de propósito: a mesma instância uazapi é
  // usada por outro sistema, e excluir `wasSentByApi` apagava do nosso chat as
  // mensagens que ele envia (o cliente respondia e o atendente não via o
  // contexto). O eco do nosso próprio envio é tratado no receiver — dedup por
  // `zapi_message_id` + adoção da linha pendente — e o caminho `fromMe` só
  // grava, nunca responde, então não há loop.
  excludeMessages?: string[];
  enabled?: boolean;
}

export async function configurarWebhook(params: ConfigurarWebhookParams): Promise<unknown> {
  const payload = {
    url: params.url,
    events: params.events ?? ["messages", "messages_update", "connection"],
    excludeMessages: params.excludeMessages ?? [],
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
    number: normalizarDestino(telefone),
    read: true,
  });
}

// ————————————————————————————————————————————————————————————————
// GRUPOS
// ————————————————————————————————————————————————————————————————

/**
 * Lista os grupos da instância (GET /group/list). Um grupo é um chat comum cujo
 * JID termina em '@g.us' — o envio usa os MESMOS /send/text e /send/media.
 * Só de leitura: não criamos, editamos nem saímos de grupo pelo sistema.
 */
export async function listarGrupos(): Promise<GrupoUazapi[]> {
  const resp = await chamar("GET", "/group/list");
  return extrairGruposDaResposta(resp);
}

/**
 * Detalhes de um grupo (POST /group/info) — nome, tópico e participantes
 * atualizados. Retorna null se o grupo não existir ou não for legível.
 */
export async function infoGrupo(jid: string): Promise<GrupoUazapi | null> {
  const resp = await chamar("POST", "/group/info", { groupjid: jid });
  // A rota pode devolver o Group cru ou dentro de um envelope.
  const direto = mapearGrupoUazapi(resp);
  if (direto) return direto;
  const env = (resp ?? {}) as Record<string, unknown>;
  return mapearGrupoUazapi(env.group ?? env.Group ?? env.data ?? null);
}

/**
 * Foto do grupo pela /group/info. Ela só devolve `image_*_url` que a uazapi
 * JÁ persistiu (não consulta o WhatsApp). Por isso: primeiro a leitura
 * barata; só se não houver foto nem a marca de "grupo sem foto"
 * (`picture_empty_at`) pede a atualização remota (`force`), que é lenta.
 */
export async function fotoGrupo(jid: string): Promise<string | null> {
  // Grupo cuja foto a uazapi ainda não conferiu: a /group/info vai ao WhatsApp
  // e passa fácil dos 20s padrão — mesmo sem force.
  const opts = { timeoutMs: TIMEOUT_FOTO_GRUPO_MS };
  const rapida = lerFotoGrupo(await chamar("POST", "/group/info", { groupjid: jid }, opts));
  if (rapida.url || rapida.semFoto) return rapida.url;
  const remota = await chamar("POST", "/group/info", { groupjid: jid, force: true }, opts);
  return lerFotoGrupo(remota).url;
}

/** Lista os participantes (número + nome, quando disponível) de um grupo. */
export async function participantesGrupo(jid: string): Promise<ParticipanteGrupoUazapi[]> {
  const resp = await chamar("POST", "/group/info", { groupjid: jid });
  return extrairParticipantesDaResposta(resp);
}

// ————————————————————————————————————————————————————————————————
// HISTÓRICO (buscar mensagens já entregues)
// ————————————————————————————————————————————————————————————————

/**
 * Mensagens de um chat, das mais recentes para as mais antigas.
 * `POST /message/find { chatid, limit, offset }`.
 *
 * Serve ao backfill: mensagens que a instância entregou enquanto o webhook
 * ainda descartava os eventos `wasSentByApi` não existem no nosso banco, e este
 * é o único jeito de recuperá-las.
 */
export async function buscarMensagensDoChat(params: {
  chatid: string;
  limit?: number;
  offset?: number;
}): Promise<Record<string, unknown>[]> {
  const r = (await chamar("POST", "/message/find", {
    chatid: params.chatid,
    limit: params.limit ?? 100,
    offset: params.offset ?? 0,
  })) as Record<string, unknown>;

  const lista = Array.isArray(r?.messages)
    ? r.messages
    : (Array.isArray(r) ? r : []);
  return (lista as unknown[]).filter(
    (m): m is Record<string, unknown> => !!m && typeof m === "object",
  );
}

/**
 * Chats individuais da instância, do mais recente para o mais antigo.
 * `POST /chat/find { wa_isGroup:false, sort, limit, offset }` → { chats[], pagination }.
 */
export async function listarChats(params: {
  limit: number;
  offset: number;
}): Promise<{ chats: Record<string, unknown>[]; total: number | null }> {
  const r = (await chamar("POST", "/chat/find", {
    operator: "AND",
    sort: "-wa_lastMsgTimestamp",
    wa_isGroup: false,
    limit: params.limit,
    offset: params.offset,
  })) as Record<string, unknown>;

  const lista = Array.isArray(r?.chats) ? r.chats : (Array.isArray(r) ? r : []);
  const pag = (r?.pagination ?? {}) as Record<string, unknown>;
  const total = typeof pag.totalRecords === "number" ? pag.totalRecords : null;
  return {
    chats: (lista as unknown[]).filter(
      (c): c is Record<string, unknown> => !!c && typeof c === "object",
    ),
    total,
  };
}

/**
 * Pede ao WhatsApp o histórico ANTIGO de um chat (POST /message/history-sync).
 *
 * ASSÍNCRONO: a resposta é só o "pedido enviado". As mensagens voltam depois no
 * evento `history` do webhook — por isso existe a função webhook-historico.
 *
 * `messageid` é a ÂNCORA: a uazapi busca para trás a partir dela (mande o
 * messageid cru, sem o prefixo `owner:`). Sem âncora, a instância usa a mensagem
 * mais antiga que ela conhece do chat.
 *
 * A doc avisa que a recuperação pode só acontecer com o WhatsApp aberto no
 * celular ou ativo em segundo plano, e o WhatsApp só devolve o que ainda existe
 * no aparelho. É melhor esforço, não garantia.
 */
export async function solicitarHistoricoChat(params: {
  chatid: string;
  messageid?: string | null;
  /**
   * Instante da âncora, em SEGUNDOS. Obrigatório na prática: a âncora por
   * `messageid` só funciona se a mensagem ainda estiver no banco da uazapi, que
   * guarda 7 dias — e o histórico que queremos é justamente mais antigo. Sem
   * isso a rota responde 400 "messageid not found locally for chat and
   * timestamp is required" (não documentado no OpenAPI, confirmado em produção).
   */
  timestampSegundos?: number | null;
  /**
   * Direção da mensagem-âncora. A rota pede o par (timestamp, fromMe) para
   * identificar a âncora quando o messageid já não está no banco dela — sem
   * isso responde 400 "fromMe is required".
   */
  fromMe?: boolean | null;
  count?: number;
}): Promise<unknown> {
  const payload: Record<string, unknown> = {
    number: params.chatid,
    mode: "history",
    count: Math.min(100, Math.max(1, Math.trunc(params.count ?? 100))),
  };
  if (params.messageid) payload.messageid = params.messageid;
  if (params.timestampSegundos && Number.isFinite(params.timestampSegundos)) {
    payload.timestamp = Math.trunc(params.timestampSegundos);
  }
  if (typeof params.fromMe === "boolean") payload.fromMe = params.fromMe;
  return await chamar("POST", "/message/history-sync", payload);
}

/**
 * Garante um webhook DEDICADO ao evento `history`, apontando para `url`.
 *
 * Separado de propósito: o receiver principal cria atendimento, roda triagem e
 * responde ao cliente. Um lote de histórico caindo lá dispararia bot e
 * notificação para conversa de semanas atrás. Aqui usamos `action: "add"`, que
 * cria um webhook ADICIONAL — o principal continua intacto.
 *
 * Idempotente: se já existe webhook com essa url, não cria outro.
 */
export async function garantirWebhookHistorico(
  url: string,
): Promise<{ criado: boolean; ja_existia: boolean }> {
  const atuais = await verWebhook();
  const lista = Array.isArray(atuais)
    ? atuais
    : (() => {
      const o = (atuais ?? {}) as Record<string, unknown>;
      const cand = o.webhooks ?? o.data ?? o.items;
      return Array.isArray(cand) ? cand : (o.url ? [o] : []);
    })();

  const jaTem = (lista as unknown[]).some((w) => {
    const o = (w ?? {}) as Record<string, unknown>;
    return typeof o.url === "string" && o.url.trim() === url.trim();
  });
  if (jaTem) return { criado: false, ja_existia: true };

  await chamar("POST", "/webhook", {
    action: "add",
    url,
    events: ["history"],
    excludeMessages: [],
    enabled: true,
  });
  return { criado: true, ja_existia: false };
}

// ————————————————————————————————————————————————————————————————
// CONTATO (nome / detalhes do chat)
// ————————————————————————————————————————————————————————————————

/**
 * Foto de perfil (miniatura) de uma pessoa ou grupo — POST /chat/details com
 * `preview: true`. Aceita número ou JID de grupo. null = sem foto visível.
 */
export async function buscarFotoPerfil(numeroOuJid: string): Promise<string | null> {
  const r = await chamar("POST", "/chat/details", {
    number: normalizarDestino(numeroOuJid),
    preview: true,
  });
  return fotoDoChat(r);
}

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
