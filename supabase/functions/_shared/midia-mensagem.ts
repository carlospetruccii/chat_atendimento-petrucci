// Download da mídia de uma mensagem e upload para o Storage.
//
// Compartilhado entre o webhook (tempo real), as mensagens de grupo, o backfill
// de histórico e o reprocessamento manual — todos precisam do MESMO caminho no
// bucket e do mesmo formato de `media_metadata`, senão a mesma mídia apareceria
// de dois jeitos na Inbox.

import { getSupabaseAdmin } from "./supabase-client.ts";
import { iniciarCronometro, log } from "./logger.ts";
import {
  contentTypeSeguro,
  deduzirExtensao,
  MidiaGrandeDemais,
  obterMidia,
} from "./midia-download.ts";
import { enviarStreamParaBucket } from "./midia-storage.ts";
import { EXT_FALLBACK, type TipoMensagem } from "./mensagem-uazapi.ts";
import type { Instancia } from "./uazapi-client.ts";

const BUCKET = "mensagens-midia";

/**
 * Chat individual (`mensagens`), chat de grupo (`grupo_mensagens`) ou conversa
 * do número financeiro na aba Docs (`docs_mensagens`).
 */
export type EscopoMidia = "individual" | "grupo" | "docs";

export interface BaixarMidiaParams {
  /** Nome da função chamadora — só para o log. */
  funcao: string;
  mensagemId: string;
  /** Atendimento (individual), grupo ou conversa do Docs — define a pasta no bucket. */
  atendimentoId: string;
  clientId?: string;
  /** `id` (owner:messageid) da mensagem uazapi — usado no POST /message/download. */
  zapiMessageId: string;
  /** URL direta da mídia (data.fileURL), quando presente — tentada por último. */
  urlOriginal: string | null;
  tipo: TipoMensagem;
  metaInicial: Record<string, unknown>;
  /** Default 'individual'. */
  escopo?: EscopoMidia;
}

export function tabelaDe(escopo: EscopoMidia): "mensagens" | "grupo_mensagens" | "docs_mensagens" {
  if (escopo === "grupo") return "grupo_mensagens";
  if (escopo === "docs") return "docs_mensagens";
  return "mensagens";
}

export function pastaDe(escopo: EscopoMidia, donoId: string): string {
  if (escopo === "grupo") return `grupos/${donoId}`;
  if (escopo === "docs") return `docs/${donoId}`;
  return donoId;
}

/** O Docs é o número financeiro; todo o resto é o número de atendimento. */
export function instanciaDe(escopo: EscopoMidia): Instancia {
  return escopo === "docs" ? "financeiro" : "principal";
}

export async function baixarESalvarMidia(p: BaixarMidiaParams): Promise<void> {
  const supabase = getSupabaseAdmin();
  const escopo: EscopoMidia = p.escopo ?? "individual";
  const tabela = tabelaDe(escopo);
  const t = iniciarCronometro();
  log({
    funcao: p.funcao,
    evento: "download_iniciado",
    status: "ok",
    mensagem_id: p.mensagemId,
    atendimento_id: p.atendimentoId,
    extra: { tipo: p.tipo, escopo },
  });
  try {
    const midia = await obterMidia(
      p.urlOriginal,
      p.zapiMessageId,
      undefined,
      escopo === "docs" ? instanciaDe(escopo) : undefined,
    );
    const fonte = midia.fonte;
    const mimeBruto = midia.contentType ?? (p.metaInicial.mime_type as string | null);
    // A extensão sai do mime CRU (ainda reconhece .rar, .docx…), mas o que vai
    // no bucket é o tipo sanitizado — a URL assinada é servida no domínio do
    // projeto e um `text/html` de terceiro viraria XSS.
    const contentType = contentTypeSeguro(mimeBruto);

    const ext = deduzirExtensao(mimeBruto, EXT_FALLBACK[p.tipo]);
    const path = `${pastaDe(escopo, p.atendimentoId)}/${p.mensagemId}.${ext}`;

    // Arquivo grande vai em blocos, sem nunca existir inteiro na memória da
    // função (que tem 256 MB no total). Pequeno segue pelo caminho simples.
    let tamanhoBytes: number;
    if (midia.modo === "stream") {
      const envio = await enviarStreamParaBucket({
        bucket: BUCKET,
        path,
        contentType,
        corpo: midia.corpo,
        tamanho: midia.tamanho,
      });
      tamanhoBytes = envio.bytes;
      log({
        funcao: p.funcao,
        evento: "upload_em_blocos",
        status: "ok",
        mensagem_id: p.mensagemId,
        duracao_ms: envio.duracaoMs,
        extra: { bytes: envio.bytes, blocos: envio.blocos },
      });
    } else {
      const { error: errUp } = await supabase.storage
        .from(BUCKET)
        .upload(path, midia.buf, { contentType, upsert: true });
      if (errUp) throw new Error(`storage_upload: ${errUp.message}`);
      tamanhoBytes = midia.buf.byteLength;
    }

    // Reprocessamento: a tentativa anterior deixou as marcas de falha gravadas.
    // Elas TÊM que sair, senão a bolha continua mostrando "Mídia indisponível"
    // mesmo com o arquivo já no bucket.
    const {
      download_falhou: _falhou,
      download_erro_motivo: _motivo,
      download_erro_codigo: _codigo,
      download_erro_bytes: _bytes,
      download_tentativa_em: _tentativa,
      ...metaLimpa
    } = p.metaInicial;

    const novaMeta = {
      ...metaLimpa,
      mime_type: contentType,
      tamanho_bytes: tamanhoBytes,
      bucket: BUCKET,
      storage_path: path,
      url_original_zapi: p.urlOriginal,
    };

    let upd = supabase
      .from(tabela)
      .update({ media_url: path, media_metadata: novaMeta })
      .eq("id", p.mensagemId);
    // Docs: se o cliente apagou a mensagem enquanto o arquivo baixava, o
    // download não pode trazer a mídia de volta. (Só no Docs por enquanto.)
    if (escopo === "docs") upd = upd.is("apagada_em", null);
    const { data: gravadas, error: errUpd } = await upd.select("id");
    if (errUpd) throw new Error(`update_mensagem: ${errUpd.message}`);
    if (escopo === "docs" && (gravadas ?? []).length === 0) {
      await supabase.storage.from(BUCKET).remove([path]);
      log({
        funcao: p.funcao,
        evento: "download_descartado_apagada",
        status: "ok",
        mensagem_id: p.mensagemId,
      });
      return;
    }

    log({
      funcao: p.funcao,
      evento: "download_sucesso",
      status: "ok",
      mensagem_id: p.mensagemId,
      atendimento_id: p.atendimentoId,
      duracao_ms: t(),
      extra: { tamanho_bytes: tamanhoBytes, mime: contentType, fonte, escopo },
    });
  } catch (err) {
    const motivo = err instanceof Error ? err.message.slice(0, 140) : "falha desconhecida";
    const grande = err instanceof MidiaGrandeDemais;
    log({
      funcao: p.funcao,
      evento: "download_falha",
      status: "erro",
      mensagem_id: p.mensagemId,
      atendimento_id: p.atendimentoId,
      duracao_ms: t(),
      erro_msg: motivo,
      extra: { escopo, codigo: grande ? "grande_demais" : "falha" },
    });
    // Marca para o retry manual ("Tentar novamente" na bolha). O código separa
    // o que adianta tentar de novo do que nunca vai caber no Storage.
    const novaMeta = {
      ...p.metaInicial,
      download_falhou: true,
      download_erro_motivo: motivo,
      download_erro_codigo: grande ? "grande_demais" : "falha",
      ...(grande ? { download_erro_bytes: err.bytes } : {}),
      url_original_zapi: p.urlOriginal,
    };
    let updFalha = supabase
      .from(tabela)
      .update({ media_metadata: novaMeta })
      .eq("id", p.mensagemId);
    if (escopo === "docs") updFalha = updFalha.is("apagada_em", null);
    await updFalha;
  }
}
