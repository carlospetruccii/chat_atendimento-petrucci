// Mensagens de GRUPO recebidas pelo webhook.
//
// Grupo é deliberadamente um caminho paralelo ao atendimento: não cria cliente,
// não abre atendimento, não passa por triagem, não chama o bot, não mexe em
// departamento. Só registra a mensagem em `grupo_mensagens` e, se for mídia,
// baixa o arquivo. Nada aqui pode disparar automação para o grupo.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { log } from "../_shared/logger.ts";
import { deduzirExtensao, obterBytesMidia } from "../_shared/midia-download.ts";
import { infoGrupo } from "../_shared/uazapi-client.ts";
import {
  EXT_FALLBACK,
  type MensagemParseada,
  TIPOS_COM_DOWNLOAD,
  type TipoMensagem,
} from "../_shared/mensagem-uazapi.ts";
import { adotarEcoProprio, aguardarAssentarEco } from "./eco.ts";
import { extrairIdentidadeGrupo, extrairNomeGrupo } from "./grupos-logic.ts";

const FUNCAO = "webhook-zapi-receive";
const BUCKET = "mensagens-midia";

// Empresa do webhook. Hoje há UMA instância uazapi = UMA empresa, então o valor
// é fixo (o mesmo default das tabelas). Quando houver mais de uma instância, a
// empresa passa a sair do `owner`/`token` do envelope e este ponto muda — mas
// deixamos explícito aqui em vez de depender do DEFAULT da coluna, para o lugar
// a mudar ser óbvio.
const COMPANY_ID_INSTANCIA = "11111111-1111-1111-1111-111111111111";

// Content-Type de arquivo recebido de terceiro: sem whitelist, um `text/html`
// subiria para o bucket e seria servido no domínio do projeto pela URL assinada.
// Tipo desconhecido vira binário inerte (o download continua funcionando).
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

function contentTypeSeguro(bruto: string | null | undefined): string {
  const base = (bruto ?? "").split(";")[0].trim().toLowerCase();
  return MIMES_PERMITIDOS.has(base) ? base : "application/octet-stream";
}

export interface ResultadoRegistroGrupo {
  ok: boolean;
  /** Motivo do descarte, quando não gravou. */
  motivo?: string;
  duplicada?: boolean;
  mensagemId?: string;
  grupoId?: string;
}

interface GrupoResolvido {
  id: string;
  companyId: string;
  /** true quando a linha acabou de ser criada por esta mensagem. */
  criado: boolean;
}

/**
 * Encontra o grupo pelo JID; se ainda não existir, cria. Um grupo aparece aqui
 * quando alguém manda mensagem nele antes de qualquer sincronização — nesse caso
 * gravamos com o nome que o webhook trouxer e completamos com /group/info em
 * background (o nome também é corrigido na próxima sincronização).
 */
async function resolverGrupo(
  supabase: SupabaseClient,
  jid: string,
  nomeDoWebhook: string | null,
): Promise<GrupoResolvido | null> {
  const { data: existente, error: errSel } = await supabase
    .from("grupos")
    .select("id, company_id, nome, ativo")
    .eq("wa_jid", jid)
    .eq("company_id", COMPANY_ID_INSTANCIA)
    .maybeSingle();

  if (errSel) {
    log({
      funcao: FUNCAO,
      evento: "grupo_select_erro",
      status: "erro",
      erro_msg: errSel.message,
    });
    return null;
  }

  if (existente) {
    // Grupo conhecido. Duas correções oportunistas, sem bloquear a mensagem:
    // reativa se voltou a falar (tínhamos marcado inativo) e preenche o nome se
    // estava vazio.
    const patch: Record<string, unknown> = {};
    if (existente.ativo !== true) patch.ativo = true;
    if (!existente.nome && nomeDoWebhook) patch.nome = nomeDoWebhook;
    if (Object.keys(patch).length > 0) {
      await supabase.from("grupos").update(patch).eq("id", existente.id);
    }
    return {
      id: existente.id as string,
      companyId: existente.company_id as string,
      criado: false,
    };
  }

  const { data: criado, error: errIns } = await supabase
    .from("grupos")
    .insert({ company_id: COMPANY_ID_INSTANCIA, wa_jid: jid, nome: nomeDoWebhook })
    .select("id, company_id")
    .maybeSingle();

  if (errIns) {
    // Corrida: outro evento do mesmo grupo criou a linha primeiro.
    const { data: recuperado } = await supabase
      .from("grupos")
      .select("id, company_id")
      .eq("wa_jid", jid)
      .eq("company_id", COMPANY_ID_INSTANCIA)
      .maybeSingle();
    if (recuperado) {
      return {
        id: recuperado.id as string,
        companyId: recuperado.company_id as string,
        criado: false,
      };
    }
    log({
      funcao: FUNCAO,
      evento: "grupo_insert_erro",
      status: "erro",
      erro_msg: errIns.message,
    });
    return null;
  }
  if (!criado) return null;

  log({ funcao: FUNCAO, evento: "grupo_criado", status: "ok", extra: { grupo_id: criado.id } });
  return { id: criado.id as string, companyId: criado.company_id as string, criado: true };
}

/** Completa nome/tópico/participantes de um grupo recém-descoberto. */
async function completarDadosDoGrupo(
  supabase: SupabaseClient,
  grupoId: string,
  jid: string,
): Promise<void> {
  try {
    const info = await infoGrupo(jid);
    if (!info) return;
    await supabase
      .from("grupos")
      .update({
        nome: info.nome,
        topico: info.topico,
        foto_url: info.fotoUrl,
        participantes_total: info.participantesTotal,
        sou_admin: info.souAdmin,
        somente_admin_envia: info.somenteAdminEnvia,
        synced_at: new Date().toISOString(),
      })
      .eq("id", grupoId);
  } catch (err) {
    // Best-effort: a mensagem já está salva; a sincronização manual corrige.
    log({
      funcao: FUNCAO,
      evento: "grupo_info_falha",
      status: "erro",
      erro_msg: err instanceof Error ? err.message.slice(0, 140) : String(err),
      extra: { grupo_id: grupoId },
    });
  }
}

async function baixarESalvarMidiaGrupo(params: {
  supabase: SupabaseClient;
  mensagemId: string;
  grupoId: string;
  uazapiMessageId: string;
  urlOriginal: string | null;
  tipo: TipoMensagem;
  metaInicial: Record<string, unknown>;
}): Promise<void> {
  const { supabase, mensagemId, grupoId, uazapiMessageId, urlOriginal, tipo, metaInicial } = params;
  try {
    const { buf, contentType: ctDetectado, fonte } = await obterBytesMidia(
      urlOriginal,
      uazapiMessageId,
    );
    const contentType = contentTypeSeguro(
      ctDetectado ?? (metaInicial.mime_type as string | null),
    );
    const ext = deduzirExtensao(contentType, EXT_FALLBACK[tipo]);
    const path = `grupos/${grupoId}/${mensagemId}.${ext}`;

    const { error: errUp } = await supabase.storage
      .from(BUCKET)
      .upload(path, buf, { contentType, upsert: true });
    if (errUp) throw new Error(`storage_upload: ${errUp.message}`);

    const { error: errUpd } = await supabase
      .from("grupo_mensagens")
      .update({
        media_url: path,
        media_metadata: {
          ...metaInicial,
          mime_type: contentType,
          tamanho_bytes: buf.byteLength,
          bucket: BUCKET,
          storage_path: path,
        },
      })
      .eq("id", mensagemId);
    if (errUpd) throw new Error(`update_mensagem: ${errUpd.message}`);

    log({
      funcao: FUNCAO,
      evento: "grupo_download_sucesso",
      status: "ok",
      mensagem_id: mensagemId,
      extra: { tamanho_bytes: buf.byteLength, mime: contentType, fonte },
    });
  } catch (err) {
    const motivo = err instanceof Error ? err.message.slice(0, 140) : "falha desconhecida";
    log({
      funcao: FUNCAO,
      evento: "grupo_download_falha",
      status: "erro",
      mensagem_id: mensagemId,
      erro_msg: motivo,
    });
    await supabase
      .from("grupo_mensagens")
      .update({
        media_metadata: { ...metaInicial, download_falhou: true, download_erro_motivo: motivo },
      })
      .eq("id", mensagemId);
  }
}

/**
 * Registra uma mensagem de grupo. Idempotente pelo UNIQUE em
 * grupo_mensagens.uazapi_message_id — reentrega da uazapi não duplica.
 */
export async function registrarMensagemGrupo(params: {
  supabase: SupabaseClient;
  payload: Record<string, unknown>;
  envelope: Record<string, unknown>;
  parsed: MensagemParseada;
  uazapiMessageId: string | null;
  /** Id da mensagem citada NA UAZAPI (campo `quoted`), se houver. */
  quotedUazapiId: string | null;
  /** Eco de envio feito pela API (nosso `grupo-enviar` ou outro sistema). */
  wasSentByApi?: boolean;
}): Promise<ResultadoRegistroGrupo> {
  const { supabase, payload, envelope, parsed, uazapiMessageId, quotedUazapiId } = params;
  const wasSentByApi = params.wasSentByApi === true;

  const ident = extrairIdentidadeGrupo(payload, envelope);
  if (!ident) return { ok: false, motivo: "grupo_sem_jid" };

  // Inbound sem número de participante não cabe no CHECK da tabela (e sem saber
  // quem falou a mensagem não serve para nada na UI).
  if (!ident.fromMe && !ident.participanteNumero) {
    return { ok: false, motivo: "grupo_participante_desconhecido" };
  }

  const grupo = await resolverGrupo(
    supabase,
    ident.jid,
    extrairNomeGrupo(payload, envelope),
  );
  if (!grupo) return { ok: false, motivo: "grupo_nao_resolvido" };

  // Grupo novo: busca nome/tópico/participantes na uazapi (não bloqueia).
  if (grupo.criado) {
    const tarefaInfo = completarDadosDoGrupo(supabase, grupo.id, ident.jid);
    const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
      .EdgeRuntime;
    if (edge?.waitUntil) edge.waitUntil(tarefaInfo);
    else tarefaInfo.catch(() => {});
  }

  // Eco do nosso próprio `grupo-enviar` que ainda não gravou o id da uazapi:
  // adota a linha existente em vez de duplicar a mensagem no grupo. Duas
  // tentativas com folga entre elas — mesma corrida do chat individual.
  if (wasSentByApi && ident.fromMe && uazapiMessageId) {
    const reconhecerProprio = async (): Promise<string | null> => {
      const { data: jaGravada } = await supabase
        .from("grupo_mensagens")
        .select("id")
        .eq("uazapi_message_id", uazapiMessageId)
        .maybeSingle();
      if (jaGravada?.id) return jaGravada.id as string;
      return await adotarEcoProprio({
        supabase,
        tabela: "grupo_mensagens",
        colunaMessageId: "uazapi_message_id",
        escopo: { coluna: "grupo_id", valor: grupo.id },
        eco: parsed,
        messageId: uazapiMessageId,
      });
    };

    let propriaId = await reconhecerProprio();
    if (!propriaId) {
      await aguardarAssentarEco();
      propriaId = await reconhecerProprio();
    }
    if (propriaId) {
      log({
        funcao: FUNCAO,
        evento: "grupo_eco_proprio",
        status: "ok",
        mensagem_id: propriaId,
        extra: { grupo_id: grupo.id, uazapi_message_id: uazapiMessageId },
      });
      return { ok: true, duplicada: true, grupoId: grupo.id, mensagemId: propriaId };
    }
  }

  // Citação: resolve o id da uazapi para a NOSSA linha de grupo_mensagens.
  let replyToMessageId: string | null = null;
  if (quotedUazapiId) {
    const { data: citada } = await supabase
      .from("grupo_mensagens")
      .select("id")
      .eq("uazapi_message_id", quotedUazapiId)
      .maybeSingle();
    replyToMessageId = (citada?.id as string | undefined) ?? null;
  }

  // fromMe = mandamos do celular da empresa, fora do sistema: mesma semântica
  // do 'externo' do chat individual (a UI marca "Enviado fora do sistema").
  const { data: inserida, error: errIns } = await supabase
    .from("grupo_mensagens")
    .insert({
      company_id: grupo.companyId,
      grupo_id: grupo.id,
      direction: ident.fromMe ? "outbound" : "inbound",
      sender_type: ident.fromMe ? "externo" : "participante",
      sent_by_user_id: null,
      participante_numero: ident.fromMe ? null : ident.participanteNumero,
      participante_nome: ident.fromMe ? null : ident.participanteNome,
      tipo: parsed.tipo,
      content: parsed.content,
      media_url: parsed.media_url,
      media_metadata: parsed.media_metadata,
      uazapi_message_id: uazapiMessageId,
      status_envio: "enviado",
      status_whatsapp: null,
      reply_to_message_id: replyToMessageId,
    })
    .select("id")
    .maybeSingle();

  if (errIns) {
    const ehUnique = errIns.code === "23505" ||
      /duplicate key|uniq_grupo_mensagens_uazapi_message_id/i.test(errIns.message);
    if (ehUnique) {
      log({
        funcao: FUNCAO,
        evento: "grupo_mensagem_duplicada",
        status: "ok",
        extra: { uazapi_message_id: uazapiMessageId },
      });
      return { ok: true, duplicada: true, grupoId: grupo.id };
    }
    log({
      funcao: FUNCAO,
      evento: "grupo_insert_mensagem_erro",
      status: "erro",
      erro_msg: errIns.message,
      extra: { grupo_id: grupo.id },
    });
    return { ok: false, motivo: "insert_falhou" };
  }
  if (!inserida) return { ok: false, motivo: "insert_sem_retorno" };

  const mensagemId = inserida.id as string;
  log({
    funcao: FUNCAO,
    evento: "grupo_mensagem_persistida",
    status: "ok",
    mensagem_id: mensagemId,
    extra: { grupo_id: grupo.id, tipo: parsed.tipo, from_me: ident.fromMe },
  });

  if (TIPOS_COM_DOWNLOAD.has(parsed.tipo) && uazapiMessageId) {
    const tarefa = baixarESalvarMidiaGrupo({
      supabase,
      mensagemId,
      grupoId: grupo.id,
      uazapiMessageId,
      urlOriginal: parsed.media_url,
      tipo: parsed.tipo,
      metaInicial: parsed.media_metadata ?? {},
    });
    const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
      .EdgeRuntime;
    if (edge?.waitUntil) edge.waitUntil(tarefa);
    else tarefa.catch(() => {});
  }

  return { ok: true, mensagemId, grupoId: grupo.id };
}
