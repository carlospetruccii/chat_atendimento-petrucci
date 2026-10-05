// Edge Function: send-whatsapp-message
// Envio outbound de mensagem do atendente para o cliente via Z-API.
//
// Contrato com o frontend:
//   POST { atendimento_id: string, mensagem_id?: string }
//
// Fluxo:
//  1. Valida JWT do atendente.
//  2. Localiza a mensagem alvo:
//       - Se 'mensagem_id' veio, usa essa.
//       - Caso contrário, pega a mensagem mais recente do atendimento em
//         status_envio='aguardando_envio', criada pelo próprio usuário
//         (sender_type='atendente', sent_by_user_id = auth.uid()).
//     Garante que pertence ao atendimento informado e ainda está aguardando.
//  3. Confere autorização: o usuário é o assigned_to do atendimento,
//     OU é superadmin, OU tem permissão 'force_close'.
//  4. Marca a mensagem como 'enviando' e responde 200 ao frontend imediatamente.
//  5. Em background: chama Z-API. Sucesso → 'enviado' + zapi_message_id.
//                                  Falha   → 'falha' + media_metadata.erro_motivo.
//
// O INSERT da mensagem é responsabilidade do frontend (UI otimista).
// Esta função NUNCA insere — apenas despacha e atualiza.
// O cron-retry-mensagens-falha cobre o reenvio de mensagens em 'falha'.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { gravarIdPosEnvio } from "../_shared/pos-envio.ts";
import { atualizacaoAposErroEnvio } from "../_shared/erro-envio.ts";
import {
  enviarMidia,
  enviarTexto,
  extrairMessageId,
  type TipoMidia,
  ZapiError,
} from "../_shared/uazapi-client.ts";

const FUNCAO = "send-whatsapp-message";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface PayloadEnvio {
  atendimento_id?: string;
  mensagem_id?: string;
}

const MAPA_TIPO_ZAPI: Record<string, TipoMidia> = {
  imagem: "image",
  audio: "audio",
  video: "video",
  documento: "document",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Mapeia erros técnicos da Z-API em mensagens curtas e legíveis para o atendente.

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, erro: "method_not_allowed" }, 405);
  }

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // 1) Autenticação: lê o JWT do header e resolve o usuário.
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!jwt) {
    log({ funcao: FUNCAO, evento: "sem_token", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }

  const { data: userRes, error: errUser } = await supabase.auth.getUser(jwt);
  if (errUser || !userRes?.user) {
    log({
      funcao: FUNCAO,
      evento: "token_invalido",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: errUser?.message,
    });
    return jsonResponse({ ok: false, erro: "unauthorized" }, 401);
  }
  const userId = userRes.user.id;

  // 2) Parse e validação do payload.
  let payload: PayloadEnvio;
  try {
    payload = (await req.json()) as PayloadEnvio;
  } catch {
    log({ funcao: FUNCAO, evento: "payload_invalido", status: "erro", duracao_ms: cron() });
    return jsonResponse({ ok: false, erro: "payload_invalido" }, 400);
  }

  const atendimentoId = payload.atendimento_id?.trim();
  const mensagemIdInformado = payload.mensagem_id?.trim() || null;
  if (!atendimentoId) {
    return jsonResponse(
      { ok: false, erro: "campos_obrigatorios", detalhe: "atendimento_id é obrigatório" },
      400,
    );
  }

  // 3) Carrega atendimento + cliente para autorização e número de destino.
  const { data: atend, error: errAtend } = await supabase
    .from("atendimentos")
    .select(
      "id, assigned_to, current_department_id, status, client_id, clients:client_id(numero_whatsapp)",
    )
    .eq("id", atendimentoId)
    .maybeSingle();

  if (errAtend) {
    log({
      funcao: FUNCAO,
      evento: "leitura_atendimento",
      status: "erro",
      atendimento_id: atendimentoId,
      duracao_ms: cron(),
      erro_msg: errAtend.message,
    });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
  if (!atend) {
    return jsonResponse({ ok: false, erro: "atendimento_nao_encontrado" }, 404);
  }

  // 4) Autorização: assigned_to OU superadmin OU permissão 'force_close'.
  let autorizado = atend.assigned_to === userId;
  if (!autorizado) {
    const [{ data: userRow }, { data: permRow }] = await Promise.all([
      supabase.from("users").select("is_superadmin").eq("id", userId).maybeSingle(),
      supabase
        .from("user_permissions")
        .select("permission")
        .eq("user_id", userId)
        .eq("permission", "force_close")
        .maybeSingle(),
    ]);
    if (userRow?.is_superadmin || permRow) autorizado = true;
  }
  if (!autorizado) {
    log({
      funcao: FUNCAO,
      evento: "forbidden",
      status: "erro",
      atendimento_id: atendimentoId,
      duracao_ms: cron(),
    });
    return jsonResponse({ ok: false, erro: "forbidden" }, 403);
  }

  const numeroWhatsapp = (atend as { clients?: { numero_whatsapp?: string } }).clients
    ?.numero_whatsapp?.replace(/\D/g, "");
  if (!numeroWhatsapp) {
    return jsonResponse({ ok: false, erro: "cliente_sem_numero" }, 422);
  }

  // 5) Localiza a mensagem alvo (já inserida pelo frontend em 'aguardando_envio').
  let queryMsg = supabase
    .from("mensagens")
    .select("id, atendimento_id, sent_by_user_id, tipo, content, media_url, media_metadata, status_envio, reply_to_message_id")
    .eq("atendimento_id", atendimentoId)
    .eq("direction", "outbound")
    .eq("sender_type", "atendente")
    .eq("sent_by_user_id", userId)
    .eq("status_envio", "aguardando_envio");

  if (mensagemIdInformado) {
    queryMsg = queryMsg.eq("id", mensagemIdInformado);
  }

  const { data: msgs, error: errMsg } = await queryMsg
    .order("created_at", { ascending: false })
    .limit(1);

  if (errMsg) {
    log({
      funcao: FUNCAO,
      evento: "leitura_mensagem",
      status: "erro",
      atendimento_id: atendimentoId,
      duracao_ms: cron(),
      erro_msg: errMsg.message,
    });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
  const msg = msgs?.[0];
  if (!msg) {
    log({
      funcao: FUNCAO,
      evento: "mensagem_nao_encontrada",
      status: "erro",
      atendimento_id: atendimentoId,
      duracao_ms: cron(),
      extra: { mensagem_id: mensagemIdInformado },
    });
    return jsonResponse({ ok: false, erro: "mensagem_nao_encontrada" }, 404);
  }

  const mensagemId = msg.id as string;
  const tipo = msg.tipo as string;
  const content = msg.content as string | null;
  const mediaUrl = msg.media_url as string | null;
  const mediaMetadata = (msg.media_metadata as Record<string, unknown> | null) ?? null;
  const replyToMessageId = (msg as { reply_to_message_id?: string | null }).reply_to_message_id ?? null;

  // Resolve zapi_message_id da mensagem citada (se houver).
  let quotedZapiMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: quoted } = await supabase
      .from("mensagens")
      .select("zapi_message_id")
      .eq("id", replyToMessageId)
      .maybeSingle();
    if (quoted?.zapi_message_id) quotedZapiMessageId = quoted.zapi_message_id as string;
  }

  // 6) Marca como 'enviando' (lock otimista: só atualiza se ainda estiver 'aguardando_envio').
  const { data: locked, error: errLock } = await supabase
    .from("mensagens")
    .update({ status_envio: "enviando" })
    .eq("id", mensagemId)
    .eq("status_envio", "aguardando_envio")
    .select("id");

  if (errLock) {
    log({
      funcao: FUNCAO,
      evento: "lock_envio",
      status: "erro",
      atendimento_id: atendimentoId,
      mensagem_id: mensagemId,
      duracao_ms: cron(),
      erro_msg: errLock.message,
    });
    return jsonResponse({ ok: false, erro: "erro_interno" }, 500);
  }
  if (!locked || locked.length === 0) {
    // Outro processo (ou retry) já pegou essa mensagem.
    log({
      funcao: FUNCAO,
      evento: "envio_ja_em_andamento",
      status: "ok",
      atendimento_id: atendimentoId,
      mensagem_id: mensagemId,
      duracao_ms: cron(),
    });
    return jsonResponse({ ok: true, mensagem_id: mensagemId, status_envio: "enviando" });
  }

  log({
    funcao: FUNCAO,
    evento: "envio_iniciado",
    status: "ok",
    atendimento_id: atendimentoId,
    mensagem_id: mensagemId,
    duracao_ms: cron(),
    extra: { tipo },
  });

  // 7) Tarefa em background: chama Z-API e atualiza status final.
  const tarefaEnvio = (async () => {
    const t = iniciarCronometro();
    try {
      let respostaZapi: unknown;
      if (tipo === "texto") {
        if (!content || !content.trim()) {
          throw new Error("Mensagem texto sem conteúdo");
        }
        respostaZapi = await enviarTexto({
          telefone: numeroWhatsapp,
          mensagem: content.trim(),
          quotedZapiMessageId,
        });
      } else {
        const tipoZapi = MAPA_TIPO_ZAPI[tipo];
        if (!tipoZapi) {
          throw new Error(`Tipo de mensagem não suportado para envio: ${tipo}`);
        }
        if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
          throw new Error("media_url ausente ou inválida");
        }
        respostaZapi = await enviarMidia({
          telefone: numeroWhatsapp,
          tipo: tipoZapi,
          url: mediaUrl,
          caption: typeof content === "string" && content.trim() ? content.trim() : undefined,
          fileName: typeof mediaMetadata?.file_name === "string"
            ? (mediaMetadata.file_name as string)
            : typeof mediaMetadata?.nome_original === "string"
              ? (mediaMetadata.nome_original as string)
              : undefined,
          quotedZapiMessageId,
        });
      }

      const zapiMessageId = extrairMessageId(respostaZapi);

      const posEnvio = await gravarIdPosEnvio({
        supabase,
        tabela: "mensagens",
        colunaMessageId: "zapi_message_id",
        mensagemId,
        messageId: zapiMessageId,
      });

      if (!posEnvio.ok) {
        log({
          funcao: FUNCAO,
          evento: "update_pos_envio",
          status: "erro",
          atendimento_id: atendimentoId,
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
          atendimento_id: atendimentoId,
          mensagem_id: mensagemId,
        });
      }

      log({
        funcao: FUNCAO,
        evento: "envio_sucesso",
        status: "ok",
        atendimento_id: atendimentoId,
        mensagem_id: mensagemId,
        duracao_ms: t(),
      });
    } catch (err) {
      const upd = atualizacaoAposErroEnvio(err, mediaMetadata);
      await supabase
        .from("mensagens")
        .update(upd)
        .eq("id", mensagemId);

      log({
        funcao: FUNCAO,
        evento: upd.status_envio === "falha" ? "envio_falha" : "envio_incerto",
        status: upd.status_envio === "falha" ? "erro" : "ok",
        atendimento_id: atendimentoId,
        mensagem_id: mensagemId,
        duracao_ms: t(),
        erro_msg: (upd.media_metadata.erro_motivo ?? upd.media_metadata.envio_incerto_motivo) as string,
        extra: {
          zapi_status: err instanceof ZapiError ? err.status : null,
          status_envio: upd.status_envio,
        },
      });
    }
  })();

  const edge = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (edge?.waitUntil) {
    edge.waitUntil(tarefaEnvio);
  } else {
    tarefaEnvio.catch(() => {});
  }

  return jsonResponse({
    ok: true,
    mensagem_id: mensagemId,
    status_envio: "enviando",
  });
});
