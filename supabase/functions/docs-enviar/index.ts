// Edge Function: docs-enviar
// Envia mensagem numa conversa da aba Docs, PELO NÚMERO FINANCEIRO: texto,
// imagem, vídeo, documento ou nota de voz. Mesmo fluxo do grupo-enviar.
//
// Contrato com o frontend:
//   POST { conversa_id, tipo: "texto"|"image"|"video"|"document"|"audio",
//          content?, arquivo_base64?, mime_type?, nome_arquivo?, duracao_seg?,
//          reply_to_message_id? }
//   → { ok, mensagem_id, status_envio }
//
// Autorização: membro ativo + acesso ao Docs + DONO da conversa em andamento.
// Todo mundo com acesso vê tudo, mas só o dono escreve (decisão de produto).
//
// Único caminho de escrita outbound em docs_mensagens: a autoria
// (sent_by_user_id) vem sempre do JWT, nunca do corpo.
//
// Docs não tem bot: nada aqui consulta o kill switch nem dispara automação.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { atualizacaoAposErroEnvio } from "../_shared/erro-envio.ts";
import { gravarIdPosEnvio } from "../_shared/pos-envio.ts";
import {
  enviarMidia,
  enviarTexto,
  extrairMessageId,
  type TipoMidia,
  ZapiError,
} from "../_shared/uazapi-client.ts";
import { exigirAcessoDocs, usuarioDoJwt } from "../_shared/docs-acesso.ts";
import { TRACK_SOURCE_DOCS } from "../_shared/docs-rastreio.ts";
import {
  deduzirExtensao,
  MAX_BYTES_ANEXO,
  podeEscrever,
  TIPO_MENSAGEM_POR_ENVIO,
  validarEnvioDocs,
} from "./logic.ts";

const FUNCAO = "docs-enviar";
const BUCKET = "mensagens-midia";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// Mesmo motivo do grupo-enviar: o Content-Type vem do corpo da requisição e
// define como o navegador serve o arquivo pela URL assinada.
const MIMES_PERMITIDOS = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/webm",
  "application/pdf",
]);

function contentTypeSeguro(bruto: string): string {
  const base = bruto.split(";")[0].trim().toLowerCase();
  return MIMES_PERMITIDOS.has(base) ? base : "application/octet-stream";
}

/** Remove URLs de um texto antes de persistir (podem conter URL assinada). */
function semUrls(texto: string): string {
  return texto.replace(/https?:\/\/\S+/gi, "[url]");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // 1) Autenticação.
  const userId = await usuarioDoJwt(supabase, req);
  if (!userId) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);

  // 2) Payload.
  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return jsonResponse({ ok: false, erro: "payload_invalido" }, 400);
  }
  const validacao = validarEnvioDocs((bruto ?? {}) as Record<string, unknown>);
  if (!validacao.ok) {
    return jsonResponse({ ok: false, erro: validacao.erro }, validacao.status);
  }
  const envio = validacao.envio;

  // 3) Autorização: empresa + acesso ao Docs + dono da conversa.
  const membro = await exigirAcessoDocs(supabase, userId);
  if (!membro) {
    log({ funcao: FUNCAO, evento: "sem_acesso_docs", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "forbidden" }, 403);
  }
  const companyId = membro.companyId;

  const { data: conversa, error: errConv } = await supabase
    .from("docs_conversas")
    .select("id, company_id, status, assigned_to, clients!inner(numero_whatsapp)")
    .eq("id", envio.conversaId)
    .maybeSingle();

  if (errConv) {
    log({ funcao: FUNCAO, evento: "select_conversa_erro", status: "erro", erro_msg: errConv.message });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
  if (!conversa || conversa.company_id !== companyId) {
    return jsonResponse({ ok: false, erro: "conversa_nao_encontrada" }, 404);
  }
  if (!podeEscrever(conversa as { status: string; assigned_to: string | null }, userId)) {
    return jsonResponse({ ok: false, erro: "nao_e_dono" }, 403);
  }
  const cliente = (Array.isArray(conversa.clients) ? conversa.clients[0] : conversa.clients) as
    | { numero_whatsapp: string }
    | null;
  const telefone = cliente?.numero_whatsapp;
  if (!telefone) return jsonResponse({ ok: false, erro: "cliente_sem_numero" }, 409);

  // 3b) Citação: tem que ser DESTA conversa (o replyid apontaria para outra).
  let quotedUazapiId: string | undefined;
  if (envio.replyToMessageId) {
    const { data: citada } = await supabase
      .from("docs_mensagens")
      .select("id, uazapi_message_id")
      .eq("id", envio.replyToMessageId)
      .eq("conversa_id", envio.conversaId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (!citada) return jsonResponse({ ok: false, erro: "reply_invalido" }, 400);
    const id = citada.uazapi_message_id as string | null;
    if (id) quotedUazapiId = id;
  }

  // 4) Mídia: upload no bucket privado. `media_url` guarda o CAMINHO; a URL
  //    assinada curta vai só para a uazapi buscar o arquivo.
  let mediaUrl: string | null = null;
  let urlParaUazapi: string | null = null;
  let mediaMetadata: Record<string, unknown> | null = null;

  if (envio.tipo !== "texto" && envio.arquivoBase64) {
    const bytes = decodeBase64(envio.arquivoBase64);
    if (!bytes) return jsonResponse({ ok: false, erro: "arquivo_invalido" }, 400);
    if (bytes.byteLength > MAX_BYTES_ANEXO) {
      return jsonResponse({ ok: false, erro: "arquivo_muito_grande" }, 413);
    }
    const contentType = contentTypeSeguro(envio.mimeType);
    const ext = deduzirExtensao(envio.nomeArquivo, contentType, envio.tipo);
    const storagePath = `docs/${envio.conversaId}/${crypto.randomUUID()}.${ext}`;

    const { error: errUp } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, bytes, { contentType, upsert: false });
    if (errUp) {
      log({ funcao: FUNCAO, evento: "upload_falhou", status: "erro", erro_msg: errUp.message });
      return jsonResponse({ ok: false, erro: "upload_falhou" }, 500);
    }

    const { data: signed } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, 15 * 60);
    urlParaUazapi = signed?.signedUrl ?? null;
    if (!urlParaUazapi) {
      log({ funcao: FUNCAO, evento: "signed_url_falhou", status: "erro", duracao_ms: cron() });
      return jsonResponse({ ok: false, erro: "upload_falhou" }, 500);
    }
    mediaUrl = storagePath;
    mediaMetadata = {
      storage_path: storagePath,
      bucket: BUCKET,
      mime_type: contentType,
      file_name: envio.nomeArquivo,
      extensao: ext,
      tamanho_bytes: bytes.byteLength,
      ...(envio.duracaoSeg !== null ? { duracao_seg: envio.duracaoSeg } : {}),
    };
  }

  // 5) Grava antes de falar com o WhatsApp: se a uazapi cair, a mensagem existe
  //    com status de erro e a tela mostra o que aconteceu.
  const { data: inserida, error: errIns } = await supabase
    .from("docs_mensagens")
    .insert({
      company_id: companyId,
      conversa_id: envio.conversaId,
      direction: "outbound",
      sender_type: "atendente",
      sent_by_user_id: userId,
      tipo: TIPO_MENSAGEM_POR_ENVIO[envio.tipo],
      content: envio.content,
      media_url: mediaUrl,
      media_metadata: mediaMetadata,
      status_envio: "enviando",
      reply_to_message_id: envio.replyToMessageId,
    })
    .select("id")
    .single();

  if (errIns || !inserida) {
    log({ funcao: FUNCAO, evento: "insert_falhou", status: "erro", erro_msg: errIns?.message });
    return jsonResponse({ ok: false, erro: "insert_falhou" }, 500);
  }
  const mensagemId = inserida.id as string;

  log({
    funcao: FUNCAO,
    evento: "envio_iniciado",
    status: "ok",
    mensagem_id: mensagemId,
    duracao_ms: cron(),
    extra: { tipo: envio.tipo },
  });

  // 6) Envio em background pelo número FINANCEIRO.
  const tarefa = (async () => {
    const t = iniciarCronometro();
    try {
      const resposta = envio.tipo === "texto"
        ? await enviarTexto({
          telefone,
          mensagem: envio.content ?? "",
          quotedZapiMessageId: quotedUazapiId,
          instancia: "financeiro",
          // O eco volta com esta marca: o webhook-docs-receive adota a linha
          // pelo id, sem risco de confundir com documento do outro sistema.
          rastreio: { origem: TRACK_SOURCE_DOCS, id: mensagemId },
        })
        : await enviarMidia({
          telefone,
          tipo: envio.tipo as TipoMidia,
          url: urlParaUazapi!,
          caption: envio.content ?? undefined,
          fileName: envio.tipo === "document" ? envio.nomeArquivo : undefined,
          quotedZapiMessageId: quotedUazapiId,
          instancia: "financeiro",
          rastreio: { origem: TRACK_SOURCE_DOCS, id: mensagemId },
        });

      const posEnvio = await gravarIdPosEnvio({
        supabase,
        tabela: "docs_mensagens",
        colunaMessageId: "uazapi_message_id",
        mensagemId,
        messageId: extrairMessageId(resposta),
      });

      if (!posEnvio.ok) {
        log({
          funcao: FUNCAO,
          evento: "update_pos_envio",
          status: "erro",
          mensagem_id: mensagemId,
          duracao_ms: t(),
          erro_msg: posEnvio.erro ?? "erro_desconhecido",
        });
        return;
      }
      log({
        funcao: FUNCAO,
        evento: posEnvio.conflito ? "update_pos_envio_conflito_eco" : "envio_sucesso",
        status: "ok",
        mensagem_id: mensagemId,
        duracao_ms: t(),
      });
    } catch (err) {
      const upd = atualizacaoAposErroEnvio(err, mediaMetadata, { sanitizarMotivo: semUrls });
      const { error: errUpd } = await supabase.from("docs_mensagens").update(upd).eq("id", mensagemId);
      if (errUpd) {
        log({
          funcao: FUNCAO,
          evento: "update_erro_envio_falhou",
          status: "erro",
          mensagem_id: mensagemId,
          erro_msg: errUpd.message,
        });
      }
      log({
        funcao: FUNCAO,
        evento: upd.status_envio === "falha" ? "envio_falha" : "envio_incerto",
        status: upd.status_envio === "falha" ? "erro" : "ok",
        mensagem_id: mensagemId,
        duracao_ms: t(),
        erro_msg: (upd.media_metadata.erro_motivo ?? upd.media_metadata.envio_incerto_motivo) as string,
        extra: { uazapi_status: err instanceof ZapiError ? err.status : null },
      });
    }
  })();

  const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (edge?.waitUntil) edge.waitUntil(tarefa);
  else tarefa.catch(() => {});

  return jsonResponse({ ok: true, mensagem_id: mensagemId, status_envio: "enviando" });
});
