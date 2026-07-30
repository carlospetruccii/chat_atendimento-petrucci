// Download da mídia de uma mensagem individual e upload para o Storage.
//
// Compartilhado entre o webhook (tempo real) e o backfill de histórico — os dois
// precisam do MESMO caminho no bucket e do mesmo formato de `media_metadata`,
// senão a mesma mídia apareceria de dois jeitos na Inbox.

import { getSupabaseAdmin } from "./supabase-client.ts";
import { iniciarCronometro, log } from "./logger.ts";
import { deduzirExtensao, obterBytesMidia } from "./midia-download.ts";
import { EXT_FALLBACK, type TipoMensagem } from "./mensagem-uazapi.ts";

const BUCKET = "mensagens-midia";

export interface BaixarMidiaParams {
  /** Nome da função chamadora — só para o log. */
  funcao: string;
  mensagemId: string;
  atendimentoId: string;
  clientId: string;
  /** `id` (owner:messageid) da mensagem uazapi — usado no POST /message/download. */
  zapiMessageId: string;
  /** URL direta da mídia (data.fileURL), quando presente — tentada primeiro. */
  urlOriginal: string | null;
  tipo: TipoMensagem;
  metaInicial: Record<string, unknown>;
}

export async function baixarESalvarMidia(p: BaixarMidiaParams): Promise<void> {
  const supabase = getSupabaseAdmin();
  const t = iniciarCronometro();
  log({
    funcao: p.funcao,
    evento: "download_iniciado",
    status: "ok",
    mensagem_id: p.mensagemId,
    atendimento_id: p.atendimentoId,
    extra: { tipo: p.tipo },
  });
  try {
    const { buf, contentType: ctDetectado, fonte } = await obterBytesMidia(
      p.urlOriginal,
      p.zapiMessageId,
    );
    const contentType = ctDetectado ??
      (p.metaInicial.mime_type as string | null) ?? "application/octet-stream";

    const ext = deduzirExtensao(contentType, EXT_FALLBACK[p.tipo]);
    const path = `${p.atendimentoId}/${p.mensagemId}.${ext}`;

    const { error: errUp } = await supabase.storage
      .from(BUCKET)
      .upload(path, buf, { contentType, upsert: true });
    if (errUp) throw new Error(`storage_upload: ${errUp.message}`);

    const novaMeta = {
      ...p.metaInicial,
      mime_type: contentType,
      tamanho_bytes: buf.byteLength,
      bucket: BUCKET,
      storage_path: path,
      url_original_zapi: p.urlOriginal,
    };

    const { error: errUpd } = await supabase
      .from("mensagens")
      .update({ media_url: path, media_metadata: novaMeta })
      .eq("id", p.mensagemId);
    if (errUpd) throw new Error(`update_mensagem: ${errUpd.message}`);

    log({
      funcao: p.funcao,
      evento: "download_sucesso",
      status: "ok",
      mensagem_id: p.mensagemId,
      atendimento_id: p.atendimentoId,
      duracao_ms: t(),
      extra: { tamanho_bytes: buf.byteLength, mime: contentType, fonte },
    });
  } catch (err) {
    const motivo = err instanceof Error ? err.message.slice(0, 140) : "falha desconhecida";
    log({
      funcao: p.funcao,
      evento: "download_falha",
      status: "erro",
      mensagem_id: p.mensagemId,
      atendimento_id: p.atendimentoId,
      duracao_ms: t(),
      erro_msg: motivo,
    });
    // Marca para o cron de retry futuro.
    const novaMeta = {
      ...p.metaInicial,
      download_falhou: true,
      download_erro_motivo: motivo,
      url_original_zapi: p.urlOriginal,
    };
    await supabase
      .from("mensagens")
      .update({ media_metadata: novaMeta })
      .eq("id", p.mensagemId);
  }
}
