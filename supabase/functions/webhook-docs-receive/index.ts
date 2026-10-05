// Edge Function: webhook-docs-receive
// Endpoint público chamado pela uazapi com os eventos do NÚMERO FINANCEIRO
// (segunda instância, secret UAZAPI_TOKEN_FINANCEIRO). Alimenta a aba Docs.
//
// Separado do webhook-zapi-receive de propósito: um erro aqui não pode parar a
// Inbox, e nada daqui pode chegar perto de triagem, bot ou atendimento.
//
// O que chega e o que vira:
//   - mensagem do cliente           → docs_mensagens inbound (o gatilho do banco
//                                     põe a conversa em 'sem_dono' se preciso)
//   - documento do outro sistema    → outbound 'externo', origem 'api_externa'
//   - mensagem enviada do celular   → outbound 'externo', origem 'celular'
//   - eco do que a aba Docs enviou  → adotado (grava o id na nossa linha)
//   - entregue/lido/apagada         → atualiza a mensagem
//   - grupo                         → ignorado (Docs é só conversa individual)
//
// Princípios (os mesmos do webhook principal):
//   - 200 quando o evento foi tratado ou ignorado por regra (a uazapi não
//     reenvia em loop); 500 só em falha momentânea de banco, para reentregar.
//   - Idempotente pelo UNIQUE em docs_mensagens.uazapi_message_id.
//   - Nunca responde ao cliente: só grava. Sem loop possível.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { buscarNomeContato } from "../_shared/uazapi-client.ts";
import { baixarESalvarMidia } from "../_shared/midia-mensagem.ts";
import { dataDaMensagem, parseMensagem, TIPOS_COM_DOWNLOAD } from "../_shared/mensagem-uazapi.ts";
import { mascararLid, normalizarNumero, resolverClienteIdent } from "../_shared/cliente-ident.ts";
import { adotarEcoProprio, aguardarAssentarEco } from "../webhook-zapi-receive/eco.ts";
import {
  chatIndividualValido,
  classificarEcoDocs,
  urlMidiaConfiavel,
} from "../_shared/docs-rastreio.ts";
import { COMPANY_ID_INSTANCIA } from "../webhook-zapi-receive/grupos.ts";
import { conversaDocsDoCliente } from "../_shared/docs-conversa.ts";
import { avisarSeNecessario } from "../_shared/docs-aviso.ts";
import {
  classificarEvento,
  escolherNomeContato,
  mapStatusWhatsapp,
  origemExterna,
} from "./logic.ts";

const FUNCAO = "webhook-docs-receive";
const BUCKET = "mensagens-midia";
// Envelope da uazapi é JSON pequeno (mídia vem por URL, não inline). Corta
// antes de parsear um corpo gigante num endpoint público.
const MAX_BYTES_CORPO = 2 * 1024 * 1024;
// Sem marca de rastreio no eco, a heurística só olha envios MUITO recentes:
// a instância é compartilhada e o outro sistema também ecoa como API.
const JANELA_ECO_SEM_RASTREIO_MS = 60_000;

type Supabase = ReturnType<typeof getSupabaseAdmin>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function comparaConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function emSegundoPlano(tarefa: Promise<unknown>): void {
  const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (edge?.waitUntil) edge.waitUntil(tarefa);
  else tarefa.catch(() => {});
}

/** "Apagada para todos" (pelo cliente ou por nós): carimba, idempotente. */
async function carimbarApagada(supabase: Supabase, uazapiId: string): Promise<boolean> {
  const { data: msg } = await supabase
    .from("docs_mensagens")
    .select("id, apagada_em, media_metadata")
    .eq("uazapi_message_id", uazapiId)
    .maybeSingle();
  if (!msg || msg.apagada_em) return false;

  const meta = (msg.media_metadata ?? {}) as Record<string, unknown>;
  const { storage_path: caminho, ...resto } = meta;
  const { error } = await supabase
    .from("docs_mensagens")
    .update({
      apagada_em: new Date().toISOString(),
      content: null,
      media_url: null,
      media_metadata: { ...resto, apagada: true },
    })
    .eq("id", msg.id)
    .is("apagada_em", null);
  if (error) {
    log({
      funcao: FUNCAO,
      evento: "carimbo_apagada_erro",
      status: "erro",
      mensagem_id: msg.id,
      erro_msg: error.message,
    });
    return false;
  }
  // O cliente apagou: o arquivo sai do bucket também (URL assinada já emitida
  // deixa de funcionar).
  if (typeof caminho === "string" && caminho) {
    await supabase.storage.from(BUCKET).remove([caminho]);
  }
  return true;
}

/**
 * Eco com a NOSSA marca de rastreio: o `track_id` é o id da linha que o
 * docs-enviar/docs-acao gravou. Adoção exata, sem comparar conteúdo.
 * Devolve o id da linha (adotada agora ou já adotada), ou null se a marca não
 * apontar para uma linha desta conversa.
 */
async function adotarPorRastreio(
  supabase: Supabase,
  mensagemId: string,
  conversaId: string,
  uazapiId: string,
): Promise<string | null> {
  const { data: linha } = await supabase
    .from("docs_mensagens")
    .select("id, uazapi_message_id, media_metadata")
    .eq("id", mensagemId)
    .eq("conversa_id", conversaId)
    .maybeSingle();
  if (!linha) return null;
  if (linha.uazapi_message_id) return linha.id as string;

  const meta = { ...((linha.media_metadata ?? {}) as Record<string, unknown>) };
  delete meta.envio_incerto_em;
  delete meta.envio_incerto_motivo;
  await supabase
    .from("docs_mensagens")
    .update({
      uazapi_message_id: uazapiId,
      status_envio: "enviado",
      media_metadata: Object.keys(meta).length > 0 ? meta : null,
    })
    .eq("id", linha.id)
    .is("uazapi_message_id", null);
  log({ funcao: FUNCAO, evento: "eco_proprio_adotado_rastreio", status: "ok", mensagem_id: linha.id });
  return linha.id as string;
}

async function tratarStatus(
  supabase: Supabase,
  messageId: string | null,
  statusRaw: string | null,
): Promise<Response> {
  if (messageId && statusRaw && /DELET|REVOK/i.test(statusRaw)) {
    const apagada = await carimbarApagada(supabase, messageId);
    log({ funcao: FUNCAO, evento: "mensagem_apagada_por_webhook", status: "ok", extra: { apagada } });
    return jsonResponse({ ok: true, apagada });
  }

  const novoStatus = mapStatusWhatsapp(statusRaw);
  if (!novoStatus || !messageId) {
    log({ funcao: FUNCAO, evento: "status_ignorado", status: "ok", extra: { status_raw: statusRaw } });
    return jsonResponse({ ok: true });
  }

  const { data, error } = await supabase
    .from("docs_mensagens")
    .update({ status_whatsapp: novoStatus })
    .eq("uazapi_message_id", messageId)
    .select("id");
  if (error) {
    log({ funcao: FUNCAO, evento: "status_update_erro", status: "erro", erro_msg: error.message });
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ ok: true, atualizadas: data?.length ?? 0 });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  const tamanho = Number(req.headers.get("content-length") ?? "0");
  if (tamanho > MAX_BYTES_CORPO) {
    log({ funcao: FUNCAO, evento: "payload_grande_demais", status: "erro", extra: { bytes: tamanho } });
    return jsonResponse({ ok: false, erro: "payload_grande_demais" }, 413);
  }

  let envelope: Record<string, unknown>;
  try {
    envelope = (await req.json()) as Record<string, unknown>;
  } catch {
    log({ funcao: FUNCAO, evento: "payload_invalido", status: "erro" });
    return jsonResponse({ ok: true, ignorado: "payload_invalido" });
  }

  // Origem: a uazapi manda o token da instância no corpo. FAIL-CLOSED — sem o
  // secret configurado, recusa (um payload forjado gravaria mensagem falsa).
  const esperado = Deno.env.get("UAZAPI_TOKEN_FINANCEIRO");
  if (!esperado) {
    log({ funcao: FUNCAO, evento: "secret_ausente", status: "erro" });
    return jsonResponse({ ok: false, erro: "misconfigured" }, 503);
  }
  const recebido = typeof envelope.token === "string" ? envelope.token : null;
  if (!recebido || !comparaConstante(recebido, esperado)) {
    log({ funcao: FUNCAO, evento: "token_invalido", status: "erro" });
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }

  const ev = classificarEvento(envelope);
  const { payload, messageId } = ev;

  log({
    funcao: FUNCAO,
    evento: "uazapi_webhook_recebido",
    status: "ok",
    extra: {
      event: ev.evento,
      rota: ev.rota,
      message_type: (payload.messageType as string | undefined) ?? null,
      from_me: ev.fromMe,
      was_sent_by_api: ev.wasSentByApi,
      is_group: ev.ehGrupo,
      status_raw: ev.statusRaw,
    },
  });

  if (ev.rota === "conexao" || ev.rota === "desconhecido") return jsonResponse({ ok: true });

  try {
    if (ev.rota === "status") return await tratarStatus(supabase, messageId, ev.statusRaw);

    if (ev.ehGrupo) {
      log({ funcao: FUNCAO, evento: "evento_ignorado", status: "ok", extra: { motivo: "grupo" } });
      return jsonResponse({ ok: true, ignorado: "grupo" });
    }
    if (!chatIndividualValido(payload.chatid)) {
      log({ funcao: FUNCAO, evento: "evento_ignorado", status: "ok", extra: { motivo: "chat_nao_individual" } });
      return jsonResponse({ ok: true, ignorado: "chat_nao_individual" });
    }
    if (ev.wasSentByApi && !ev.fromMe) {
      log({
        funcao: FUNCAO,
        evento: "evento_ignorado",
        status: "ok",
        extra: { motivo: "was_sent_by_api_sem_from_me" },
      });
      return jsonResponse({ ok: true });
    }

    const parsed = parseMensagem(payload);
    if (!parsed || !messageId) {
      log({
        funcao: FUNCAO,
        evento: "evento_ignorado",
        status: "ok",
        extra: {
          motivo: parsed ? "sem_message_id" : "tipo_nao_suportado",
          message_type: (payload.messageType as string | undefined) ?? null,
        },
      });
      return jsonResponse({ ok: true });
    }

    // Idempotência prévia (reentrega da uazapi ou eco já gravado).
    const { data: jaExiste } = await supabase
      .from("docs_mensagens")
      .select("id")
      .eq("uazapi_message_id", messageId)
      .maybeSingle();
    if (jaExiste) return jsonResponse({ ok: true, duplicada: true });

    // Cliente. Em fromMe o remetente somos nós: o cliente é o chatid, e o nome
    // dele vem do objeto `chat` do envelope ou da própria uazapi.
    let nomeContato: string | null;
    if (ev.fromMe) {
      const chat = (envelope.chat && typeof envelope.chat === "object")
        ? envelope.chat as Record<string, unknown>
        : {};
      nomeContato = escolherNomeContato(
        chat.wa_contactName,
        chat.wa_name,
        chat.name,
        chat.lead_name,
        chat.pushName,
        chat.verifiedName,
        payload.chatName,
      );
      // Só para envio feito do CELULAR: documento do outro sistema chega em
      // lote, e uma consulta à uazapi por documento competiria com ele pelo
      // limite de requisições da instância compartilhada. O nome chega sozinho
      // quando o cliente responder.
      if (!nomeContato && !ev.wasSentByApi) {
        const numeroChat = normalizarNumero((payload.chatid as string | undefined) ?? null);
        if (numeroChat) nomeContato = await buscarNomeContato(numeroChat, "financeiro");
      }
    } else {
      nomeContato = escolherNomeContato(payload.senderName, payload.pushName);
    }

    const resolved = await resolverClienteIdent(payload, supabase, {
      companyId: COMPANY_ID_INSTANCIA,
      permitirCriar: true,
      senderName: nomeContato,
      preferChatid: ev.fromMe,
      funcao: FUNCAO,
    });
    if ("erro" in resolved) {
      // Erro de BANCO ao resolver o cliente é transitório: 500 faz a uazapi
      // reentregar (o webhook é idempotente). Conflito de identidade e chat sem
      // telefone são lógicos — reentregar não muda nada, então 200.
      const transitorio = resolved.erro === "criar_erro" &&
        !/^conflito_/.test(resolved.detalhe ?? "");
      log({
        funcao: FUNCAO,
        evento: resolved.erro === "criar_erro" ? "criar_cliente_erro" : "evento_ignorado",
        status: resolved.erro === "criar_erro" ? "erro" : "ok",
        erro_msg: resolved.erro === "criar_erro" ? resolved.detalhe : undefined,
        extra: {
          motivo: resolved.erro,
          from_me: ev.fromMe,
          chat_lid_mask: mascararLid((payload.sender_lid as string | undefined) ?? null),
        },
      });
      return transitorio
        ? jsonResponse({ ok: false, erro: "tente_de_novo" }, 500)
        : jsonResponse({ ok: true });
    }

    const conversaId = await conversaDocsDoCliente(supabase, COMPANY_ID_INSTANCIA, resolved.id, FUNCAO);
    if (!conversaId) {
      log({ funcao: FUNCAO, evento: "conversa_indefinida", status: "erro", client_id: resolved.id });
      return jsonResponse({ ok: false, erro: "tente_de_novo" }, 500);
    }

    // Eco do NOSSO envio (docs-enviar / docs-acao). Com a marca de rastreio é
    // exato; marcado por outro sistema nunca é adotado; sem os campos de
    // rastreio no payload, heurística curta e sem linhas "incertas".
    if (ev.fromMe && ev.wasSentByApi) {
      const marca = classificarEcoDocs(payload);
      if (marca.tipo === "nosso") {
        const proprio = await adotarPorRastreio(supabase, marca.mensagemId, conversaId, messageId);
        if (proprio) return jsonResponse({ ok: true, mensagem_id: proprio, eco_proprio: true });
      } else if (marca.tipo === "sem_rastreio") {
        const reconhecer = async (): Promise<string | null> => {
          const { data: gravada } = await supabase
            .from("docs_mensagens")
            .select("id")
            .eq("uazapi_message_id", messageId)
            .maybeSingle();
          if (gravada?.id) return gravada.id as string;
          return await adotarEcoProprio({
            supabase,
            tabela: "docs_mensagens",
            colunaMessageId: "uazapi_message_id",
            escopo: { coluna: "conversa_id", valor: conversaId },
            eco: parsed,
            messageId,
            funcao: FUNCAO,
            janelaMs: JANELA_ECO_SEM_RASTREIO_MS,
            excluirIncertos: true,
          });
        };
        const proprio = (await reconhecer()) ??
          (await aguardarAssentarEco().then(reconhecer));
        if (proprio) return jsonResponse({ ok: true, mensagem_id: proprio, eco_proprio: true });
      }
    }

    // Citação: só dentro da MESMA conversa.
    let replyTo: string | null = null;
    if (ev.quotedId) {
      const { data: ref } = await supabase
        .from("docs_mensagens")
        .select("id")
        .eq("uazapi_message_id", ev.quotedId)
        .eq("conversa_id", conversaId)
        .maybeSingle();
      replyTo = (ref?.id as string | undefined) ?? null;
    }

    const criadoEm = dataDaMensagem(payload);
    const origem = ev.fromMe ? origemExterna(payload.wasSentByApi) : null;
    const temMidia = TIPOS_COM_DOWNLOAD.has(parsed.tipo);
    // Documento do outro sistema: baixa SÓ quando alguém pedir (botão na bolha
    // → docs-acao reprocessar_midia). Um disparo em massa dele viraria centenas
    // de downloads na mesma instância, competindo com os envios dele.
    const sobDemanda = temMidia && origem === "api_externa";
    const meta: Record<string, unknown> | null = ev.fromMe
      ? {
        ...(parsed.media_metadata ?? {}),
        origem,
        ...(sobDemanda
          ? {
            download_falhou: true,
            download_erro_codigo: "sob_demanda",
            download_erro_motivo: "Documento enviado pelo sistema financeiro. Toque para baixar.",
            url_original_zapi: urlMidiaConfiavel(parsed.media_url),
          }
          : {}),
      }
      : (parsed.media_metadata ?? null);

    const { data: inserida, error: errIns } = await supabase
      .from("docs_mensagens")
      .insert({
        company_id: COMPANY_ID_INSTANCIA,
        conversa_id: conversaId,
        direction: ev.fromMe ? "outbound" : "inbound",
        sender_type: ev.fromMe ? "externo" : "cliente",
        sent_by_user_id: null,
        tipo: parsed.tipo,
        content: parsed.content,
        media_url: parsed.media_url,
        media_metadata: meta,
        uazapi_message_id: messageId,
        status_envio: "enviado",
        status_whatsapp: ev.fromMe ? "enviado" : null,
        reply_to_message_id: replyTo,
        ...(criadoEm ? { created_at: criadoEm } : {}),
      })
      .select("id")
      .maybeSingle();

    if (errIns) {
      if (errIns.code === "23505" || /duplicate key/i.test(errIns.message)) {
        return jsonResponse({ ok: true, duplicada: true });
      }
      log({
        funcao: FUNCAO,
        evento: "insert_mensagem_erro",
        status: "erro",
        erro_msg: errIns.message,
        extra: { from_me: ev.fromMe },
      });
      // Mensagem de cliente não pode sumir por uma falha momentânea do banco:
      // 500 faz a uazapi reentregar (idempotente pelo UNIQUE do id).
      return jsonResponse({ ok: false, erro: "tente_de_novo" }, 500);
    }

    const mensagemId = inserida!.id as string;
    log({
      funcao: FUNCAO,
      evento: ev.fromMe ? "mensagem_externa_persistida" : "mensagem_persistida",
      status: "ok",
      mensagem_id: mensagemId,
      client_id: resolved.id,
      duracao_ms: cron(),
      extra: { tipo: parsed.tipo, conversa_id: conversaId },
    });

    // Resposta automática "número só de documentos" (1x a cada 3h, sem dono).
    if (!ev.fromMe) {
      emSegundoPlano((async () => {
        const { data: cli } = await supabase
          .from("clients")
          .select("numero_whatsapp")
          .eq("id", resolved.id)
          .maybeSingle();
        if (!cli?.numero_whatsapp) return;
        await avisarSeNecessario({
          supabase,
          funcao: FUNCAO,
          companyId: COMPANY_ID_INSTANCIA,
          conversaId,
          telefone: cli.numero_whatsapp as string,
        });
      })());
    }

    if (temMidia && !sobDemanda) {
      emSegundoPlano(baixarESalvarMidia({
        funcao: FUNCAO,
        mensagemId,
        atendimentoId: conversaId,
        clientId: resolved.id,
        zapiMessageId: messageId,
        // Só URL https do WhatsApp: o número recebe mídia de qualquer pessoa.
        urlOriginal: urlMidiaConfiavel(parsed.media_url),
        tipo: parsed.tipo,
        metaInicial: meta ?? {},
        escopo: "docs",
      }));
    }

    return jsonResponse({ ok: true, mensagem_id: mensagemId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ funcao: FUNCAO, evento: "erro_inesperado", status: "erro", erro_msg: msg.slice(0, 200) });
    return jsonResponse({ ok: true, erro_interno: true });
  }
});
