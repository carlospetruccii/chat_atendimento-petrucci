// Edge Function: docs-acao
// Ações sobre mensagens da aba Docs (número FINANCEIRO). Uma função só porque a
// autorização é a mesma para todas e é diferente da Inbox: aqui o que manda é
// ser o DONO da conversa (ou admin), não o atendimento.
//
// Contrato:
//   POST { acao: "apagar", mensagem_ids: uuid[1..10] }
//     → { ok, resultados: [{ mensagem_id, ok, motivo?, detalhe? }] }
//   POST { acao: "editar", mensagem_id, texto }
//     → { ok, mensagem_id?, editada_em?, conteudo?, motivo?, detalhe? }
//   POST { acao: "encaminhar", mensagem_id, conversa_id_destino }
//     → { ok, mensagem_id?, motivo? }
//   POST { acao: "reprocessar_midia", mensagem_id } → { ok, motivo? }
//   POST { acao: "marcar_lido", conversa_id } → { ok, motivo? }
//
// Recusa de NEGÓCIO (fora do prazo, não é o dono...) volta 200 com
// `ok:false, motivo` — senão o supabase-js entrega só "non-2xx" para a tela.
// 4xx fica para pedido malformado e falta de acesso ao Docs.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { atualizacaoAposErroEnvio } from "../_shared/erro-envio.ts";
import { gravarIdPosEnvio } from "../_shared/pos-envio.ts";
import {
  deletarMensagem,
  editarMensagem,
  enviarMidia,
  enviarTexto,
  extrairMessageId,
  marcarChatComoLido,
  ZapiError,
} from "../_shared/uazapi-client.ts";
import { avaliarAcao, type MensagemAvaliavel } from "../_shared/janelas-whatsapp.ts";
import { baixarESalvarMidia } from "../_shared/midia-mensagem.ts";
import { TIPOS_COM_DOWNLOAD, type TipoMensagem } from "../_shared/mensagem-uazapi.ts";
import { MAX_BYTES } from "../_shared/midia-download.ts";
import { exigirAcessoDocs, type MembroDocs, usuarioDoJwt } from "../_shared/docs-acesso.ts";
import { TRACK_SOURCE_DOCS, urlMidiaConfiavel } from "../_shared/docs-rastreio.ts";
import {
  avaliarEncaminhar,
  extensaoDoOriginal,
  type MediaMetadataOriginal,
  metadataEncaminhada,
  TIPO_PARA_UAZAPI,
} from "../mensagem-encaminhar/logic.ts";
import { podeEscrever } from "../docs-enviar/logic.ts";
import { ehDonoOuAdmin, type PedidoAcao, validarPedidoAcao } from "./logic.ts";

const FUNCAO = "docs-acao";
const BUCKET = "mensagens-midia";
// O eco da própria edição chega em segundos; nada mais velho que isto pode ser
// tratado como a duplicata dela (é o único DELETE físico do Docs).
const JANELA_ECO_MS = 2 * 60_000;
// Apagar até 10 mensagens, uma a uma, com a uazapi lenta podia passar dos 150s
// do gateway. Passado isto, o resto volta como "tempo_esgotado" para a tela.
const PRAZO_APAGAR_MS = 100_000;
// Mesmo freio do reprocessar-midia da Inbox: clique repetido não enfileira
// vários downloads pesados da mesma mídia.
const INTERVALO_REPROCESSO_MS = 30_000;

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

function semUrls(texto: string): string {
  return texto.replace(/https?:\/\/\S+/gi, "[url]");
}

function emSegundoPlano(tarefa: Promise<unknown>): void {
  const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (edge?.waitUntil) edge.waitUntil(tarefa);
  else tarefa.catch(() => {});
}

/** Erro técnico da uazapi → frase curta para o atendente (sem URL/token). */
function detalheFalha(err: unknown): string {
  if (err instanceof ZapiError) {
    if (err.status === 404) return "O WhatsApp não encontrou mais essa mensagem.";
    if (err.status === 429) return "WhatsApp ocupado (limite de requisições). Tente de novo.";
    if (err.status === 401 || err.status === 403) {
      return "WhatsApp recusou a credencial (verifique a conexão do número financeiro).";
    }
    if (err.status >= 500) return "WhatsApp indisponível.";
    return `WhatsApp recusou a operação (HTTP ${err.status}).`;
  }
  return "Não conseguimos falar com o WhatsApp.";
}

interface LinhaDocs {
  id: string;
  conversa_id: string;
  company_id: string;
  direction: string;
  sender_type: string;
  tipo: string;
  content: string | null;
  media_url: string | null;
  media_metadata: Record<string, unknown> | null;
  uazapi_message_id: string | null;
  status_envio: string;
  created_at: string;
  apagada_em: string | null;
}

interface ConversaDocs {
  id: string;
  company_id: string;
  status: string;
  assigned_to: string | null;
  clients: { numero_whatsapp: string } | { numero_whatsapp: string }[] | null;
}

const COLUNAS_MSG =
  "id, conversa_id, company_id, direction, sender_type, tipo, content, media_url, media_metadata, uazapi_message_id, status_envio, created_at, apagada_em";

function numeroDe(c: ConversaDocs): string | null {
  const cli = Array.isArray(c.clients) ? c.clients[0] : c.clients;
  return cli?.numero_whatsapp ?? null;
}

async function carregarConversas(
  supabase: SupabaseClient,
  companyId: string,
  ids: string[],
): Promise<Map<string, ConversaDocs>> {
  const { data } = await supabase
    .from("docs_conversas")
    .select("id, company_id, status, assigned_to, clients!inner(numero_whatsapp)")
    .eq("company_id", companyId)
    .in("id", ids);
  const mapa = new Map<string, ConversaDocs>();
  for (const c of (data ?? []) as ConversaDocs[]) mapa.set(c.id, c);
  return mapa;
}

function paraAvaliavel(m: LinhaDocs): MensagemAvaliavel {
  const origem = (m.media_metadata as { origem?: unknown } | null)?.origem;
  return {
    criadaEm: m.created_at,
    direction: m.direction,
    senderType: m.sender_type,
    tipo: m.tipo,
    statusEnvio: m.status_envio,
    apagadaEm: m.apagada_em,
    temIdWhatsapp: !!m.uazapi_message_id,
    // 'api_externa' = documento do outro sistema: nunca apagável daqui.
    origemExterna: typeof origem === "string" ? origem : null,
  };
}

// ————————————————————————————————————————————————————————————————
// APAGAR PARA TODOS
// ————————————————————————————————————————————————————————————————
async function apagar(
  supabase: SupabaseClient,
  membro: MembroDocs,
  ids: string[],
): Promise<Response> {
  const { data: linhas } = await supabase
    .from("docs_mensagens")
    .select(COLUNAS_MSG)
    .eq("company_id", membro.companyId)
    .in("id", ids);
  const msgs = (linhas ?? []) as LinhaDocs[];
  const conversas = await carregarConversas(
    supabase,
    membro.companyId,
    [...new Set(msgs.map((m) => m.conversa_id))],
  );

  const inicio = Date.now();
  const resultados: Record<string, unknown>[] = [];
  for (const id of ids) {
    if (Date.now() - inicio > PRAZO_APAGAR_MS) {
      resultados.push({ mensagem_id: id, ok: false, motivo: "tempo_esgotado" });
      continue;
    }
    const m = msgs.find((x) => x.id === id);
    const conv = m ? conversas.get(m.conversa_id) : undefined;
    if (!m || !conv) {
      resultados.push({ mensagem_id: id, ok: false, motivo: "nao_encontrada" });
      continue;
    }
    if (!ehDonoOuAdmin(conv, membro.userId, membro.isSuperadmin)) {
      resultados.push({ mensagem_id: id, ok: false, motivo: "sem_permissao" });
      continue;
    }
    const elegivel = avaliarAcao("apagar", paraAvaliavel(m), Date.now());
    if (!elegivel.pode) {
      resultados.push({ mensagem_id: id, ok: false, motivo: elegivel.motivo });
      continue;
    }
    try {
      await deletarMensagem({ zapiMessageId: m.uazapi_message_id!, instancia: "financeiro" });
    } catch (err) {
      log({
        funcao: FUNCAO,
        evento: "apagar_uazapi_falhou",
        status: "erro",
        mensagem_id: id,
        erro_msg: err instanceof Error ? err.message : String(err),
      });
      resultados.push({ mensagem_id: id, ok: false, motivo: "falha_whatsapp", detalhe: detalheFalha(err) });
      continue;
    }

    const { storage_path: path, ...resto } = m.media_metadata ?? {};
    const { error } = await supabase
      .from("docs_mensagens")
      .update({
        apagada_em: new Date().toISOString(),
        apagada_por_user_id: membro.userId,
        content: null,
        media_url: null,
        conteudo_anterior: m.content,
        media_metadata: { ...resto, apagada: true },
      })
      .eq("id", id)
      .is("apagada_em", null);
    if (error) {
      // O webhook (status Deleted) carimba de qualquer jeito; só registra.
      log({ funcao: FUNCAO, evento: "apagar_update_falhou", status: "erro", mensagem_id: id, erro_msg: error.message });
    }
    if (typeof path === "string" && path) {
      await supabase.storage.from(BUCKET).remove([path]);
    }
    log({
      funcao: FUNCAO,
      evento: "mensagem_apagada",
      status: "ok",
      mensagem_id: id,
      extra: {
        sender_type: m.sender_type,
        origem: typeof resto.origem === "string" ? resto.origem : null,
      },
    });
    resultados.push({ mensagem_id: id, ok: true });
  }
  return jsonResponse({ ok: resultados.every((r) => r.ok === true), resultados });
}

// ————————————————————————————————————————————————————————————————
// EDITAR
// ————————————————————————————————————————————————————————————————

/**
 * Grava o texto novo e o ID NOVO que o WhatsApp gerou na edição. Se o eco da
 * edição chegou antes pelo webhook-docs-receive, ele virou uma linha 'externo'
 * com esse id e o UNIQUE barra o UPDATE: a linha do eco é, por construção, a
 * duplicata — removida só se for recente, 'externo' e da mesma conversa.
 */
async function gravarEdicao(
  supabase: SupabaseClient,
  m: LinhaDocs,
  texto: string,
  novoId: string | null,
): Promise<{ ok: boolean; editadaEm: string }> {
  const editadaEm = new Date().toISOString();
  const patch: Record<string, unknown> = {
    content: texto,
    editada_em: editadaEm,
    conteudo_anterior: m.content,
  };
  if (novoId && novoId !== m.uazapi_message_id) patch.uazapi_message_id = novoId;

  const primeira = await supabase.from("docs_mensagens").update(patch).eq("id", m.id);
  if (!primeira.error) return { ok: true, editadaEm };

  const ehUnique = primeira.error.code === "23505" || /duplicate key/i.test(primeira.error.message);
  if (ehUnique && novoId) {
    const { data: eco } = await supabase
      .from("docs_mensagens")
      .select("id, sender_type, conversa_id, created_at")
      .eq("uazapi_message_id", novoId)
      .neq("id", m.id)
      .maybeSingle();
    const recente = !!eco && Date.now() - new Date(eco.created_at as string).getTime() < JANELA_ECO_MS;
    if (eco && recente && eco.sender_type === "externo" && eco.conversa_id === m.conversa_id) {
      const { error: errDel } = await supabase.from("docs_mensagens").delete().eq("id", eco.id);
      if (!errDel) {
        const segunda = await supabase.from("docs_mensagens").update(patch).eq("id", m.id);
        if (!segunda.error) return { ok: true, editadaEm };
      }
    }
  }

  // Último recurso: texto certo na tela, mantendo o id antigo.
  const semId = await supabase
    .from("docs_mensagens")
    .update({ content: texto, editada_em: editadaEm, conteudo_anterior: m.content })
    .eq("id", m.id);
  log({
    funcao: FUNCAO,
    evento: "edicao_sem_trocar_id",
    status: "erro",
    mensagem_id: m.id,
    erro_msg: primeira.error.message,
  });
  return { ok: !semId.error, editadaEm };
}

async function editar(
  supabase: SupabaseClient,
  membro: MembroDocs,
  mensagemId: string,
  texto: string,
): Promise<Response> {
  const { data } = await supabase
    .from("docs_mensagens")
    .select(COLUNAS_MSG)
    .eq("id", mensagemId)
    .eq("company_id", membro.companyId)
    .maybeSingle();
  const m = data as LinhaDocs | null;
  if (!m) return jsonResponse({ ok: false, motivo: "nao_encontrada" });

  const conv = (await carregarConversas(supabase, membro.companyId, [m.conversa_id])).get(m.conversa_id);
  if (!conv || !ehDonoOuAdmin(conv, membro.userId, membro.isSuperadmin)) {
    return jsonResponse({ ok: false, motivo: "sem_permissao" });
  }
  const elegivel = avaliarAcao("editar", paraAvaliavel(m), Date.now());
  if (!elegivel.pode) return jsonResponse({ ok: false, motivo: elegivel.motivo });

  let novoId: string | null = null;
  try {
    const r = await editarMensagem({
      zapiMessageId: m.uazapi_message_id!,
      texto,
      instancia: "financeiro",
    });
    novoId = r.novoId;
  } catch (err) {
    log({
      funcao: FUNCAO,
      evento: "editar_uazapi_falhou",
      status: "erro",
      mensagem_id: m.id,
      erro_msg: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse({ ok: false, motivo: "falha_whatsapp", detalhe: detalheFalha(err) });
  }

  const gravado = await gravarEdicao(supabase, m, texto, novoId);
  if (!gravado.ok) {
    return jsonResponse({
      ok: false,
      motivo: "falha_whatsapp",
      detalhe: "A mensagem foi editada no WhatsApp, mas não conseguimos atualizar aqui.",
    }, 500);
  }
  log({ funcao: FUNCAO, evento: "mensagem_editada", status: "ok", mensagem_id: m.id });
  return jsonResponse({ ok: true, mensagem_id: m.id, editada_em: gravado.editadaEm, conteudo: texto });
}

// ————————————————————————————————————————————————————————————————
// ENCAMINHAR (dentro do Docs)
// ————————————————————————————————————————————————————————————————
async function encaminhar(
  supabase: SupabaseClient,
  membro: MembroDocs,
  mensagemId: string,
  conversaIdDestino: string,
): Promise<Response> {
  const cron = iniciarCronometro();
  const { data } = await supabase
    .from("docs_mensagens")
    .select(COLUNAS_MSG)
    .eq("id", mensagemId)
    .eq("company_id", membro.companyId)
    .maybeSingle();
  const origem = data as LinhaDocs | null;
  if (!origem) return jsonResponse({ ok: false, motivo: "nao_encontrada" });
  if (origem.conversa_id === conversaIdDestino) {
    return jsonResponse({ ok: false, motivo: "mesma_conversa" });
  }

  const meta = (origem.media_metadata ?? {}) as MediaMetadataOriginal;
  const storagePathOriginal = typeof meta.storage_path === "string" && meta.storage_path
    ? meta.storage_path
    : null;
  // Quem tem acesso ao Docs vê toda conversa, então a ORIGEM é legível por ele;
  // o que exige dono é o DESTINO, porque lá é ele quem está escrevendo.
  const elegivel = avaliarEncaminhar({
    apagadaEm: origem.apagada_em,
    senderType: origem.sender_type,
    tipo: origem.tipo,
    midiaPronta: !!storagePathOriginal,
  });
  if (!elegivel.pode) return jsonResponse({ ok: false, motivo: elegivel.motivo });

  const destino = (await carregarConversas(supabase, membro.companyId, [conversaIdDestino]))
    .get(conversaIdDestino);
  if (!destino) return jsonResponse({ ok: false, motivo: "conversa_destino_nao_encontrada" });
  if (!podeEscrever(destino, membro.userId)) return jsonResponse({ ok: false, motivo: "nao_e_dono" });
  const telefone = numeroDe(destino);
  if (!telefone) return jsonResponse({ ok: false, motivo: "cliente_sem_numero" });

  const ehTexto = origem.tipo === "texto";
  let mediaUrl: string | null = null;
  let mediaMetadata: Record<string, unknown> | null = null;
  let urlParaUazapi: string | null = null;

  if (!ehTexto && storagePathOriginal) {
    const ext = extensaoDoOriginal(meta, storagePathOriginal);
    // Cópia nova, nunca o mesmo path: apagar a original não pode matar esta.
    const path = `docs/${conversaIdDestino}/${crypto.randomUUID()}.${ext}`;
    const { error: errCopy } = await supabase.storage.from(BUCKET).copy(storagePathOriginal, path);
    if (errCopy) {
      log({ funcao: FUNCAO, evento: "copia_midia_falhou", status: "erro", erro_msg: errCopy.message });
      return jsonResponse({ ok: false, erro: "copia_midia_falhou" }, 500);
    }
    const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(path, 15 * 60);
    if (!signed?.signedUrl) return jsonResponse({ ok: false, erro: "midia_indisponivel" }, 500);
    urlParaUazapi = signed.signedUrl;
    mediaUrl = path;
    mediaMetadata = metadataEncaminhada({
      original: meta,
      novoPath: path,
      mensagemOrigemId: mensagemId,
    }) as unknown as Record<string, unknown>;
  }

  const conteudo = origem.tipo === "audio" ? null : origem.content;
  const { data: inserida, error: errIns } = await supabase
    .from("docs_mensagens")
    .insert({
      company_id: membro.companyId,
      conversa_id: conversaIdDestino,
      direction: "outbound",
      sender_type: "atendente",
      sent_by_user_id: membro.userId,
      tipo: origem.tipo,
      content: conteudo,
      media_url: mediaUrl,
      media_metadata: mediaMetadata,
      status_envio: "enviando",
    })
    .select("id")
    .single();
  if (errIns || !inserida) {
    log({ funcao: FUNCAO, evento: "insert_falhou", status: "erro", erro_msg: errIns?.message });
    return jsonResponse({ ok: false, erro: "insert_falhou" }, 500);
  }
  const novaId = inserida.id as string;

  emSegundoPlano((async () => {
    const t = iniciarCronometro();
    try {
      const resposta = ehTexto
        ? await enviarTexto({
          telefone,
          mensagem: conteudo ?? "",
          forward: true,
          instancia: "financeiro",
          rastreio: { origem: TRACK_SOURCE_DOCS, id: novaId },
        })
        : await enviarMidia({
          telefone,
          tipo: TIPO_PARA_UAZAPI[origem.tipo],
          url: urlParaUazapi!,
          caption: conteudo ?? undefined,
          fileName: typeof mediaMetadata?.file_name === "string" ? mediaMetadata.file_name : undefined,
          forward: true,
          instancia: "financeiro",
          rastreio: { origem: TRACK_SOURCE_DOCS, id: novaId },
        });
      const posEnvio = await gravarIdPosEnvio({
        supabase,
        tabela: "docs_mensagens",
        colunaMessageId: "uazapi_message_id",
        mensagemId: novaId,
        messageId: extrairMessageId(resposta),
      });
      log({
        funcao: FUNCAO,
        evento: posEnvio.ok ? "encaminhada" : "update_pos_envio",
        status: posEnvio.ok ? "ok" : "erro",
        mensagem_id: novaId,
        duracao_ms: t(),
        erro_msg: posEnvio.erro,
      });
    } catch (err) {
      const upd = atualizacaoAposErroEnvio(err, mediaMetadata, { sanitizarMotivo: semUrls });
      const { error: errUpd } = await supabase.from("docs_mensagens").update(upd).eq("id", novaId);
      if (errUpd) {
        log({ funcao: FUNCAO, evento: "update_erro_envio_falhou", status: "erro", mensagem_id: novaId, erro_msg: errUpd.message });
      }
      log({
        funcao: FUNCAO,
        evento: upd.status_envio === "falha" ? "envio_falha" : "envio_incerto",
        status: upd.status_envio === "falha" ? "erro" : "ok",
        mensagem_id: novaId,
        duracao_ms: t(),
      });
    }
  })());

  log({
    funcao: FUNCAO,
    evento: "encaminhamento_iniciado",
    status: "ok",
    mensagem_id: novaId,
    duracao_ms: cron(),
    extra: { mensagem_origem_id: mensagemId },
  });
  return jsonResponse({ ok: true, mensagem_id: novaId });
}

// ————————————————————————————————————————————————————————————————
// REPROCESSAR MÍDIA ("Tentar novamente" na bolha)
// ————————————————————————————————————————————————————————————————
async function reprocessarMidia(
  supabase: SupabaseClient,
  membro: MembroDocs,
  mensagemId: string,
): Promise<Response> {
  const { data } = await supabase
    .from("docs_mensagens")
    .select(COLUNAS_MSG)
    .eq("id", mensagemId)
    .eq("company_id", membro.companyId)
    .maybeSingle();
  const m = data as LinhaDocs | null;
  if (!m) return jsonResponse({ ok: false, motivo: "nao_encontrada" });
  if (m.apagada_em) return jsonResponse({ ok: false, motivo: "ja_apagada" });
  if (!TIPOS_COM_DOWNLOAD.has(m.tipo as TipoMensagem) || !m.uazapi_message_id) {
    return jsonResponse({ ok: false, motivo: "tipo_sem_download" });
  }
  // Só o que veio de fora é baixado da uazapi; o que nós enviamos já nasce no bucket.
  if (m.sender_type === "atendente") return jsonResponse({ ok: false, motivo: "midia_propria" });

  const meta = m.media_metadata ?? {};
  if (typeof meta.storage_path === "string" && meta.storage_path) {
    return jsonResponse({ ok: false, motivo: "ja_disponivel" });
  }
  if (meta.download_erro_codigo === "grande_demais" && Number(meta.download_erro_bytes ?? 0) > MAX_BYTES) {
    return jsonResponse({ ok: false, motivo: "grande_demais" });
  }
  const ultima = typeof meta.download_tentativa_em === "string"
    ? Date.parse(meta.download_tentativa_em)
    : NaN;
  if (Number.isFinite(ultima) && Date.now() - ultima < INTERVALO_REPROCESSO_MS) {
    return jsonResponse({ ok: false, motivo: "tentativa_recente" });
  }

  // Carimba ANTES de disparar — é o que segura o clique repetido.
  const metaTentativa = { ...meta, download_tentativa_em: new Date().toISOString() };
  const { error: errCarimbo } = await supabase
    .from("docs_mensagens")
    .update({ media_metadata: metaTentativa })
    .eq("id", m.id);
  if (errCarimbo) return jsonResponse({ ok: false, erro: "erro_interno" }, 500);

  // O download pode levar minutos (arquivo grande): vai em segundo plano e a
  // bolha atualiza sozinha pelo realtime quando o arquivo chega.
  emSegundoPlano(baixarESalvarMidia({
    funcao: FUNCAO,
    mensagemId: m.id,
    atendimentoId: m.conversa_id,
    zapiMessageId: m.uazapi_message_id,
    urlOriginal: urlMidiaConfiavel(meta.url_original_zapi),
    tipo: m.tipo as TipoMensagem,
    metaInicial: metaTentativa,
    escopo: "docs",
  }));
  return jsonResponse({ ok: true, em_andamento: true }, 202);
}

// ————————————————————————————————————————————————————————————————
// MARCAR COMO LIDO NO WHATSAPP (tique azul) — só o dono
// ————————————————————————————————————————————————————————————————
async function marcarLido(
  supabase: SupabaseClient,
  membro: MembroDocs,
  conversaId: string,
): Promise<Response> {
  const conv = (await carregarConversas(supabase, membro.companyId, [conversaId])).get(conversaId);
  if (!conv) return jsonResponse({ ok: false, motivo: "nao_encontrada" });
  if (!podeEscrever(conv, membro.userId)) return jsonResponse({ ok: false, motivo: "nao_e_dono" });
  const telefone = numeroDe(conv);
  if (!telefone) return jsonResponse({ ok: false, motivo: "cliente_sem_numero" });
  try {
    await marcarChatComoLido(telefone, "financeiro");
    return jsonResponse({ ok: true });
  } catch (err) {
    log({
      funcao: FUNCAO,
      evento: "marcar_lido_falhou",
      status: "erro",
      erro_msg: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse({ ok: false, motivo: "falha_whatsapp" });
  }
}

async function despachar(
  supabase: SupabaseClient,
  membro: MembroDocs,
  pedido: PedidoAcao,
): Promise<Response> {
  switch (pedido.acao) {
    case "apagar":
      return await apagar(supabase, membro, pedido.mensagemIds);
    case "editar":
      return await editar(supabase, membro, pedido.mensagemId, pedido.texto);
    case "encaminhar":
      return await encaminhar(supabase, membro, pedido.mensagemId, pedido.conversaIdDestino);
    case "reprocessar_midia":
      return await reprocessarMidia(supabase, membro, pedido.mensagemId);
    case "marcar_lido":
      return await marcarLido(supabase, membro, pedido.conversaId);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);

  const supabase = getSupabaseAdmin();
  const userId = await usuarioDoJwt(supabase, req);
  if (!userId) return jsonResponse({ ok: false, erro: "unauthorized" }, 401);

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return jsonResponse({ ok: false, erro: "payload_invalido" }, 400);
  }
  const validado = validarPedidoAcao((bruto ?? {}) as Record<string, unknown>);
  if (!validado.ok) return jsonResponse({ ok: false, erro: validado.erro }, 400);

  const membro = await exigirAcessoDocs(supabase, userId);
  if (!membro) return jsonResponse({ ok: false, erro: "forbidden" }, 403);

  try {
    return await despachar(supabase, membro, validado.pedido);
  } catch (err) {
    log({
      funcao: FUNCAO,
      evento: "erro_inesperado",
      status: "erro",
      erro_msg: err instanceof Error ? err.message.slice(0, 200) : String(err),
      extra: { acao: validado.pedido.acao },
    });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
});
