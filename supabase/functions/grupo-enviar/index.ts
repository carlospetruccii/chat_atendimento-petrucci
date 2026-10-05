// Edge Function: grupo-enviar
// Envia mensagem para um GRUPO de WhatsApp: texto, imagem, vídeo, documento ou
// nota de voz. Uma função só, porque o fluxo é idêntico em tudo menos o payload
// da uazapi (as três funções separadas do chat individual já divergiram entre si).
//
// Contrato com o frontend:
//   POST { grupo_id, tipo: "texto"|"image"|"video"|"document"|"audio",
//          content?, arquivo_base64?, mime_type?, nome_arquivo?, duracao_seg?,
//          reply_to_message_id? }
//   → { ok, mensagem_id, status_envio }
//
// Autorização: qualquer membro ativo da empresa dona do grupo. Grupo NÃO tem
// atribuição nem departamento — por decisão de produto todo colaborador envia.
// Diferente do individual, aqui não há checagem de assigned_to.
//
// Este é o ÚNICO caminho de escrita em grupo_mensagens: a RLS não dá INSERT ao
// frontend, então autoria (sent_by_user_id) sempre vem do JWT, nunca do corpo.
//
// Grupo não tem bot: nada nesta função consulta o kill switch nem dispara
// automação. Só entrega o que uma pessoa escreveu.

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
import { exigirMembroAtivo } from "../_shared/empresa.ts";
import {
  deduzirExtensao,
  MAX_BYTES_ANEXO,
  TIPO_MENSAGEM_POR_ENVIO,
  validarEnvioGrupo,
} from "./logic.ts";

const FUNCAO = "grupo-enviar";
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

// Retorna null quando o base64 é inválido — vira 400 (pedido malformado), não
// 500. `atob` lança InvalidCharacterError com qualquer caractere fora do alfabeto.
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

// O Content-Type do objeto no bucket define como o navegador serve o arquivo
// pela URL assinada — e ele vem do CORPO da requisição. Sem whitelist, dava para
// subir `text/html` e ter HTML servido no domínio do projeto (mesma origem da
// API REST): phishing hospedado por nós. Tipo desconhecido vira binário inerte.
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
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!jwt) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  const { data: userRes, error: errUser } = await supabase.auth.getUser(jwt);
  if (errUser || !userRes?.user) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  const userId = userRes.user.id;

  // 2) Payload.
  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return jsonResponse({ ok: false, erro: "payload_invalido" }, 400);
  }
  const validacao = validarEnvioGrupo((bruto ?? {}) as Record<string, unknown>);
  if (!validacao.ok) {
    return jsonResponse({ ok: false, erro: validacao.erro }, validacao.status);
  }
  const envio = validacao.envio;

  // 3) Autorização: vínculo ativo em company_members + users.ativo (ver
  //    _shared/empresa.ts — é o controle de acesso real, já que o `is_member_of`
  //    do banco é no-op enquanto auth_enforcement_enabled está desligado).
  const membro = await exigirMembroAtivo(supabase, userId);
  if (!membro) {
    log({ funcao: FUNCAO, evento: "sem_vinculo_ativo", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "forbidden" }, 403);
  }
  const companyId = membro.companyId;

  const { data: grupo, error: errGrupo } = await supabase
    .from("grupos")
    .select("id, company_id, wa_jid, ativo, sou_admin, somente_admin_envia")
    .eq("id", envio.grupoId)
    .maybeSingle();

  if (errGrupo) {
    log({ funcao: FUNCAO, evento: "select_grupo_erro", status: "erro", erro_msg: errGrupo.message });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
  if (!grupo) return jsonResponse({ ok: false, erro: "grupo_nao_encontrado" }, 404);
  if (grupo.company_id !== companyId) return jsonResponse({ ok: false, erro: "forbidden" }, 403);
  if (grupo.ativo !== true) return jsonResponse({ ok: false, erro: "grupo_inativo" }, 409);
  // Grupo em modo "só admin envia" e nosso número não é admin: a uazapi
  // recusaria. Falha aqui, antes de gravar uma mensagem que nunca sairia.
  if (grupo.somente_admin_envia === true && grupo.sou_admin !== true) {
    return jsonResponse({ ok: false, erro: "grupo_somente_admin" }, 409);
  }
  const waJid = grupo.wa_jid as string;

  // 3b) Citação: a mensagem citada tem que ser DESTE grupo e desta empresa. Sem
  //     este filtro dava para citar mensagem de outro grupo (a FK de
  //     reply_to_message_id é só por id) e o `replyid` enviado ao WhatsApp
  //     apontaria para outra conversa.
  let quotedUazapiId: string | undefined;
  if (envio.replyToMessageId) {
    const { data: citada } = await supabase
      .from("grupo_mensagens")
      .select("id, uazapi_message_id")
      .eq("id", envio.replyToMessageId)
      .eq("grupo_id", envio.grupoId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (!citada) return jsonResponse({ ok: false, erro: "reply_invalido" }, 400);
    const id = citada.uazapi_message_id as string | null;
    if (id) quotedUazapiId = id;
  }

  // 4) Mídia: upload no bucket privado. `media_url` guarda o CAMINHO no bucket
  //    (o frontend assina sob demanda, 15 min, via useSignedMediaUrl); a URL
  //    assinada longa fica só na chamada à uazapi, que busca o arquivo na hora.
  //    Persistir URL assinada de 10 anos daria a quem lesse a linha uma vez um
  //    link permanente e não revogável para o bucket privado.
  let storagePath: string | null = null;
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
    storagePath = `grupos/${envio.grupoId}/${crypto.randomUUID()}.${ext}`;

    const { error: errUp } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, bytes, { contentType, upsert: false });
    if (errUp) {
      log({
        funcao: FUNCAO,
        evento: "upload_falhou",
        status: "erro",
        duracao_ms: cron(),
        erro_msg: errUp.message,
      });
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

  // 5) Grava a mensagem antes de falar com o WhatsApp: se a uazapi cair, a
  //    mensagem existe com status 'falha' e a UI mostra o que aconteceu.
  const { data: inserida, error: errIns } = await supabase
    .from("grupo_mensagens")
    .insert({
      company_id: companyId,
      grupo_id: envio.grupoId,
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
    log({
      funcao: FUNCAO,
      evento: "insert_falhou",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: errIns?.message,
    });
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

  // 6) Envio em background: a resposta ao frontend não espera a uazapi.
  const tarefa = (async () => {
    const t = iniciarCronometro();
    try {
      // A citação já foi validada e resolvida acima (quotedUazapiId) — a uazapi
      // referencia a mensagem pelo id DELA, não pelo nosso.
      const resposta = envio.tipo === "texto"
        ? await enviarTexto({
          telefone: waJid,
          mensagem: envio.content ?? "",
          quotedZapiMessageId: quotedUazapiId,
        })
        : await enviarMidia({
          telefone: waJid,
          tipo: envio.tipo as TipoMidia,
          url: urlParaUazapi!,
          caption: envio.content ?? undefined,
          fileName: envio.tipo === "document" ? envio.nomeArquivo : undefined,
          quotedZapiMessageId: quotedUazapiId,
        });

      const uazapiMessageId = extrairMessageId(resposta);
      const posEnvio = await gravarIdPosEnvio({
        supabase,
        tabela: "grupo_mensagens",
        colunaMessageId: "uazapi_message_id",
        mensagemId,
        messageId: uazapiMessageId,
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
      if (posEnvio.conflito) {
        log({
          funcao: FUNCAO,
          evento: "update_pos_envio_conflito_eco",
          status: "ok",
          mensagem_id: mensagemId,
        });
      }

      log({
        funcao: FUNCAO,
        evento: "envio_sucesso",
        status: "ok",
        mensagem_id: mensagemId,
        duracao_ms: t(),
      });
    } catch (err) {
      // Só a versão sanitizada é persistida: a linha é legível por todos os
      // membros e o corpo de erro da uazapi pode ecoar a URL assinada que
      // enviamos.
      const upd = atualizacaoAposErroEnvio(err, mediaMetadata, { sanitizarMotivo: semUrls });
      await supabase
        .from("grupo_mensagens")
        .update(upd)
        .eq("id", mensagemId);

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
