// Cliente HTTP da Z-API (WhatsApp).
// Lê secrets: ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN.
//
// Expõe duas funções: enviarTexto e enviarMidia.
// Em erro 429 (rate limit) faz retry automático com backoff crescente
// (até 3 tentativas: 1s, 3s, 9s). Outros erros HTTP são repassados como exceção.
//
// SECURITY: nunca expor o token ao frontend. Esta lib roda apenas em Edge Functions.

const BASE_URL = "https://api.z-api.io";
const MAX_TENTATIVAS = 3;

function getCredenciais(): { instanceId: string; token: string; clientToken: string } {
  const instanceId = Deno.env.get("ZAPI_INSTANCE_ID");
  const token = Deno.env.get("ZAPI_TOKEN");
  const clientToken = Deno.env.get("ZAPI_CLIENT_TOKEN");
  if (!instanceId || !token || !clientToken) {
    throw new Error(
      "Secrets ZAPI_INSTANCE_ID, ZAPI_TOKEN e/ou ZAPI_CLIENT_TOKEN ausentes.",
    );
  }
  return { instanceId, token, clientToken };
}

function urlBase(): string {
  const { instanceId, token } = getCredenciais();
  return `${BASE_URL}/instances/${instanceId}/token/${token}`;
}

export class ZapiError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "ZapiError";
    this.status = status;
    this.body = body;
  }
}

async function postComRetry(endpoint: string, payload: unknown): Promise<unknown> {
  const { clientToken } = getCredenciais();
  const url = `${urlBase()}${endpoint}`;

  let ultimoErro: ZapiError | null = null;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Client-Token": clientToken,
      },
      body: JSON.stringify(payload),
    });

    if (resp.ok) {
      // Algumas respostas Z-API podem ser vazias; tenta JSON, fallback texto.
      const texto = await resp.text();
      try {
        return texto ? JSON.parse(texto) : {};
      } catch {
        return { raw: texto };
      }
    }

    const corpo = await resp.text();

    if (resp.status === 429 && tentativa < MAX_TENTATIVAS) {
      // Backoff crescente: 1s, 3s, 9s (3^(tentativa-1) segundos).
      const esperaMs = Math.pow(3, tentativa - 1) * 1000;
      ultimoErro = new ZapiError(
        `Z-API rate limit (429), tentativa ${tentativa}/${MAX_TENTATIVAS}`,
        resp.status,
        corpo,
      );
      await new Promise((r) => setTimeout(r, esperaMs));
      continue;
    }

    // Qualquer outro erro: lança imediatamente.
    throw new ZapiError(
      `Z-API erro HTTP ${resp.status} em ${endpoint}`,
      resp.status,
      corpo,
    );
  }

  // Esgotou retries em 429.
  throw ultimoErro ??
    new ZapiError("Z-API rate limit esgotou retries", 429, "");
}

export interface EnviarTextoParams {
  // Telefone no formato E.164 sem '+' (padrão Z-API), ex: "5511999998888".
  telefone: string;
  mensagem: string;
  // zapi_message_id da mensagem citada (responder mensagem específica).
  quotedZapiMessageId?: string;
}

export async function enviarTexto(params: EnviarTextoParams): Promise<unknown> {
  const payload: Record<string, unknown> = {
    phone: params.telefone,
    message: params.mensagem,
  };
  if (params.quotedZapiMessageId) payload.messageId = params.quotedZapiMessageId;
  return await postComRetry("/send-text", payload);
}

export type TipoMidia = "image" | "audio" | "video" | "document";

export interface EnviarMidiaParams {
  telefone: string;
  tipo: TipoMidia;
  // URL pública (assinada) da mídia OU data URI base64.
  url: string;
  caption?: string;
  // Nome do arquivo (obrigatório para document).
  fileName?: string;
  // Extensão do arquivo (obrigatório para document; ex: "pdf", "docx").
  extension?: string;
  // zapi_message_id da mensagem citada (responder mensagem específica).
  quotedZapiMessageId?: string;
}

export async function enviarMidia(params: EnviarMidiaParams): Promise<unknown> {
  const payload: Record<string, unknown> = {
    phone: params.telefone,
  };

  let endpoint: string;
  switch (params.tipo) {
    case "image":
      endpoint = "/send-image";
      payload.image = params.url;
      if (params.caption) payload.caption = params.caption;
      break;
    case "audio":
      endpoint = "/send-audio";
      payload.audio = params.url;
      break;
    case "video":
      endpoint = "/send-video";
      payload.video = params.url;
      if (params.caption) payload.caption = params.caption;
      break;
    case "document": {
      const ext = (params.extension ?? "bin").toLowerCase().replace(/^\./, "");
      endpoint = `/send-document/${ext}`;
      payload.document = params.url;
      payload.fileName = params.fileName ?? `arquivo.${ext}`;
      if (params.caption) payload.caption = params.caption;
      break;
    }
  }

  if (params.quotedZapiMessageId) payload.messageId = params.quotedZapiMessageId;

  return await postComRetry(endpoint, payload);
}

export interface OpcaoLista {
  // ID estável da opção (devolvido pelo WhatsApp ao callback se houver).
  id: string;
  // Texto principal (linha em negrito) — o WhatsApp envia ESTE texto de volta
  // como mensagem comum quando o cliente toca na opção.
  title: string;
  // Texto secundário, opcional (linha cinza abaixo).
  description?: string;
}

export interface EnviarListaOpcoesParams {
  // E.164 sem '+', ex: "5511999998888".
  telefone: string;
  // Corpo da mensagem (aparece acima do botão "Ver opções").
  mensagem: string;
  // Título da lista (cabeçalho dentro do modal de opções).
  tituloLista: string;
  // Rótulo do botão que abre a lista (ex: "Ver setores").
  buttonLabel: string;
  // 2 a 10 opções (limite do WhatsApp).
  opcoes: OpcaoLista[];
}

/**
 * Envia uma mensagem interativa "List" via Z-API (/send-option-list).
 * Renderiza como mensagem com botão "Ver opções" no WhatsApp; ao tocar,
 * abre um modal com as opções. A escolha do cliente volta como mensagem
 * de texto comum cujo `body` é igual ao `title` da opção selecionada.
 */
export async function enviarListaOpcoes(params: EnviarListaOpcoesParams): Promise<unknown> {
  const payload = {
    phone: params.telefone,
    message: params.mensagem,
    optionList: {
      title: params.tituloLista,
      buttonLabel: params.buttonLabel,
      options: params.opcoes.map((o) => ({
        id: o.id,
        title: o.title,
        ...(o.description ? { description: o.description } : {}),
      })),
    },
  };
  return await postComRetry("/send-option-list", payload);
}

export interface DeletarMensagemParams {
  // E.164 sem '+', ex: "5511999998888".
  telefone: string;
  // Z-API messageId (zapi_message_id em mensagens).
  zapiMessageId: string;
}

/**
 * Deleta uma mensagem previamente enviada via Z-API (DELETE /messages).
 * Lança ZapiError em qualquer status != 2xx (inclusive janela expirada).
 * Faz backoff em 429 idem postComRetry.
 */
export async function deletarMensagem(params: DeletarMensagemParams): Promise<unknown> {
  const { clientToken } = getCredenciais();
  const qs = new URLSearchParams({
    messageId: params.zapiMessageId,
    phone: params.telefone,
    owner: "true",
  });
  const url = `${urlBase()}/messages?${qs.toString()}`;

  let ultimoErro: ZapiError | null = null;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    const resp = await fetch(url, {
      method: "DELETE",
      headers: { "Client-Token": clientToken },
    });
    if (resp.ok) {
      const texto = await resp.text();
      try {
        return texto ? JSON.parse(texto) : {};
      } catch {
        return { raw: texto };
      }
    }
    const corpo = await resp.text();
    if (resp.status === 429 && tentativa < MAX_TENTATIVAS) {
      const esperaMs = Math.pow(3, tentativa - 1) * 1000;
      ultimoErro = new ZapiError(
        `Z-API rate limit (429) delete, tentativa ${tentativa}/${MAX_TENTATIVAS}`,
        resp.status,
        corpo,
      );
      await new Promise((r) => setTimeout(r, esperaMs));
      continue;
    }
    throw new ZapiError(
      `Z-API erro HTTP ${resp.status} em DELETE /messages`,
      resp.status,
      corpo,
    );
  }
  throw ultimoErro ?? new ZapiError("Z-API delete rate limit esgotou retries", 429, "");
}
