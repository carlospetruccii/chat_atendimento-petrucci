// Classificação de erro de envio para o WhatsApp.
//
// Por que existe: timeout NÃO é prova de que a mensagem não saiu. Em 28/09/2026
// a uazapi ficou lenta, o POST /send/text estourou nossos 20s, marcamos a
// mensagem como 'falha' — e ela tinha saído. Consequência dupla: o eco do envio
// real chegou, a adoção recusou a linha (adoção ignora 'falha', de propósito) e
// a mensagem virou "Enviado por outro sistema"; e o cron-retry reenviou, o que
// entregou a mesma mensagem duas vezes ao cliente.
//
// O corte: se a uazapi RESPONDEU (UazapiError), ela recusou e a mensagem não
// saiu → 'falha'. Se ficamos sem resposta (abort, timeout, queda de conexão),
// o desfecho é desconhecido → a linha segue em 'enviando' com um carimbo, o eco
// tem tempo de adotá-la e só depois da janela o cron a trata como falha.

import { UazapiError } from "./uazapi-client.ts";

/** Quanto tempo damos para o eco chegar antes de considerar falha de verdade. */
export const JANELA_ENVIO_INCERTO_MS = 5 * 60_000;

const MOTIVO_INCERTO = "Sem resposta do WhatsApp (pode ter sido enviada)";
const MAX_MOTIVO = 140;

/** Sinais de requisição que morreu sem resposta — não sabemos se a mensagem saiu. */
const SEM_RESPOSTA = /abort|timed?[ -]?out|timeout|connection (closed|reset|refused)|error sending request|network|broken pipe|os error/i;

type Meta = Record<string, unknown> | null | undefined;

function nomeEMensagem(err: unknown): { nome: string; msg: string } {
  // DOMException não herda de Error em todo runtime: lemos os campos na mão.
  if (typeof err === "object" && err !== null) {
    const o = err as { name?: unknown; message?: unknown };
    return {
      nome: typeof o.name === "string" ? o.name : "",
      msg: typeof o.message === "string" ? o.message : "",
    };
  }
  return { nome: "", msg: "" };
}

/**
 * A uazapi ficou sem responder? Então o envio pode ter acontecido.
 *
 * Erro de validação nosso (mensagem vazia, url inválida) fica de fora: aquilo
 * nunca chegou a virar requisição, e repescar só reenviaria lixo.
 */
export function envioIndeterminado(err: unknown): boolean {
  if (err instanceof UazapiError) return false;
  const { nome, msg } = nomeEMensagem(err);
  if (nome === "AbortError" || nome === "TimeoutError") return true;
  return SEM_RESPOSTA.test(msg);
}

/** Texto de erro para a atendente ler na bolha. */
export function motivoLegivel(err: unknown): string {
  if (err instanceof UazapiError) {
    if (err.status === 429) return "WhatsApp indisponível (limite de requisições)";
    if (err.status === 401 || err.status === 403) {
      return "WhatsApp recusou a credencial (verifique a conexão)";
    }
    if (err.status === 404) return "Recurso não encontrado no WhatsApp";
    if (err.status >= 500) return "WhatsApp indisponível";
    try {
      const j = JSON.parse(err.body) as { error?: string; message?: string };
      const msg = j.error ?? j.message;
      if (typeof msg === "string" && msg) return msg.slice(0, MAX_MOTIVO);
    } catch { /* corpo não-JSON: cai no genérico */ }
    if (err.status === 400) return "Dados inválidos para envio (verifique número/mídia)";
    return `Erro no envio (HTTP ${err.status})`;
  }
  if (envioIndeterminado(err)) return MOTIVO_INCERTO;
  const { msg } = nomeEMensagem(err);
  if (msg) return msg.slice(0, MAX_MOTIVO);
  return "Falha desconhecida no envio";
}

export interface AtualizacaoErroEnvio {
  status_envio: "enviando" | "falha";
  media_metadata: Record<string, unknown>;
}

export interface OpcoesErroEnvio {
  /** Instante do erro. Só para teste — o padrão é agora. */
  agoraIso?: string;
  /**
   * Limpa o motivo antes de persistir. O padrão é `semUrls`: o corpo de erro da
   * uazapi pode ecoar a signed URL que enviamos, e o motivo fica legível na bolha.
   */
  sanitizarMotivo?: (motivo: string) => string;
}

/** Troca qualquer URL por "[url]" — nada de signed URL gravada no banco. */
export function semUrls(texto: string): string {
  return texto.replace(/https?:\/\/\S+/gi, "[url]");
}

/**
 * O que gravar na mensagem quando o envio termina em erro.
 *
 * Indeterminado → segue 'enviando' com `envio_incerto_em`; sem `erro_motivo`,
 * porque ainda não há erro para mostrar à atendente.
 * Erro claro → 'falha' com o motivo, e o carimbo de incerteza some (senão a
 * varredura do cron promoveria a mesma linha outra vez).
 */
export function atualizacaoAposErroEnvio(
  err: unknown,
  mediaMetadata: Meta,
  opcoes: OpcoesErroEnvio = {},
): AtualizacaoErroEnvio {
  const agoraIso = opcoes.agoraIso ?? new Date().toISOString();
  const sanitizar = opcoes.sanitizarMotivo ?? semUrls;
  const base = { ...(mediaMetadata ?? {}) };

  if (envioIndeterminado(err)) {
    delete base.erro_motivo;
    return {
      status_envio: "enviando",
      media_metadata: {
        ...base,
        envio_incerto_em: agoraIso,
        envio_incerto_motivo: MOTIVO_INCERTO,
      },
    };
  }

  delete base.envio_incerto_em;
  delete base.envio_incerto_motivo;
  return {
    status_envio: "falha",
    media_metadata: { ...base, erro_motivo: sanitizar(motivoLegivel(err)) },
  };
}

