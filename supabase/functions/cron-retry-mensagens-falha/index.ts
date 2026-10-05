// Edge Function: cron-retry-mensagens-falha
// Repesca mensagens outbound em status_envio='falha' e tenta reenviar via Z-API.
// Backoff por tentativa (0=imediato, 1=>=5min, 2=>=15min). Limite 50 por execução.
// Após 3 tentativas: desiste, atendente humano precisa intervir.
//
// Antes disso, varre os envios INCERTOS: quando a uazapi não responde, quem
// envia deixa a linha em 'enviando' com `envio_incerto_em` em vez de 'falha',
// porque a mensagem pode ter saído (ver _shared/erro-envio.ts). Passada a
// janela sem o eco adotar a linha, aí sim é falha e entra no retry normal.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { botEstaAtivo } from "../_shared/kill-switch.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import {
  enviarMidia,
  enviarTexto,
  type TipoMidia,
} from "../_shared/uazapi-client.ts";
import { atualizacaoAposErroEnvio, JANELA_ENVIO_INCERTO_MS } from "../_shared/erro-envio.ts";

const FUNCAO = "cron-retry-mensagens-falha";
const LIMITE_POR_EXECUCAO = 50;
const MAX_TENTATIVAS = 3;

const MAPA_TIPO_ZAPI: Record<string, TipoMidia> = {
  imagem: "image",
  audio: "audio",
  video: "video",
  documento: "document",
};


/**
 * Promove a 'falha' os envios incertos cuja janela de eco acabou.
 *
 * `zapi_message_id is null` é a prova de que nenhum eco adotou a linha: se o
 * eco tivesse chegado, ela já estaria 'enviado' com o id da uazapi.
 *
 * Grupos e Docs entram na varredura para não ficarem presos em "enviando" —
 * lá não há retry automático, a promoção só destrava a linha para a atendente
 * reenviar.
 */
async function promoverIncertosExpirados(
  supabase: SupabaseClient,
  cutoffIso: string,
): Promise<{ mensagens: number; grupos: number; docs: number }> {
  const contagem = { mensagens: 0, grupos: 0, docs: 0 };

  for (const tabela of ["mensagens", "grupo_mensagens", "docs_mensagens"] as const) {
    const coluna = tabela === "mensagens" ? "zapi_message_id" : "uazapi_message_id";
    const { data, error } = await supabase
      .from(tabela)
      .update({ status_envio: "falha" })
      .eq("status_envio", "enviando")
      .is(coluna, null)
      .not("media_metadata->>envio_incerto_em", "is", null)
      .lt("media_metadata->>envio_incerto_em", cutoffIso)
      .select("id");

    if (error) {
      log({
        funcao: FUNCAO,
        evento: "promover_incertos_erro",
        status: "erro",
        erro_msg: error.message,
        extra: { tabela },
      });
      continue;
    }

    const n = (data ?? []).length;
    if (tabela === "mensagens") contagem.mensagens = n;
    else if (tabela === "grupo_mensagens") contagem.grupos = n;
    else contagem.docs = n;

    if (n > 0) {
      log({
        funcao: FUNCAO,
        evento: "incertos_promovidos_falha",
        status: "ok",
        extra: { tabela, total: n, ids: (data ?? []).map((r) => r.id).join(",") },
      });
    }
  }

  return contagem;
}

Deno.serve(async (_req: Request) => {
  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // a) Envios incertos que passaram da janela sem o eco chegar: viram falha de
  //    verdade e, se o bot estiver ativo, entram no retry desta mesma execução.
  //    Roda ANTES do kill switch: promover não envia nada, só para de mentir
  //    "enviando" para a atendente enquanto os envios estão desligados.
  const agora = Date.now();
  const cutoffIncerto = new Date(agora - JANELA_ENVIO_INCERTO_MS).toISOString();
  const promovidos = await promoverIncertosExpirados(supabase, cutoffIncerto);

  // b) Kill switch
  if (!(await botEstaAtivo())) {
    log({
      funcao: FUNCAO,
      evento: "retry_pulado_kill_switch",
      status: "ok",
      duracao_ms: cron(),
      extra: {
        promovidos_mensagens: promovidos.mensagens,
        promovidos_grupos: promovidos.grupos,
        promovidos_docs: promovidos.docs,
      },
    });
    return new Response(JSON.stringify({ ok: true, pulado: "kill_switch", promovidos }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // c) Buscar candidatos com backoff via OR
  const cutoff5m = new Date(agora - 5 * 60_000).toISOString();
  const cutoff15m = new Date(agora - 15 * 60_000).toISOString();

  const { data: candidatos, error: errSel } = await supabase
    .from("mensagens")
    .select("id, atendimento_id, client_id, tipo, content, media_url, media_metadata, tentativas_envio, clients:client_id(numero_whatsapp)")
    .eq("status_envio", "falha")
    .lt("tentativas_envio", MAX_TENTATIVAS)
    .or(`tentativas_envio.eq.0,and(tentativas_envio.eq.1,created_at.lt.${cutoff5m}),and(tentativas_envio.eq.2,created_at.lt.${cutoff15m})`)
    .order("created_at", { ascending: true })
    .limit(LIMITE_POR_EXECUCAO);

  if (errSel) {
    log({ funcao: FUNCAO, evento: "retry_select_erro", status: "erro", duracao_ms: cron(), erro_msg: errSel.message });
    return new Response(JSON.stringify({ ok: false, erro: errSel.message }), { status: 500 });
  }

  const lista = candidatos ?? [];
  log({
    funcao: FUNCAO,
    evento: "retry_iniciado",
    status: "ok",
    extra: { candidatos: lista.length },
  });

  let sucessos = 0;
  let falhas = 0;

  for (const m of lista) {
    const t = iniciarCronometro();
    const mensagemId = m.id as string;
    const tentativaNum = (m.tentativas_envio as number) + 1;
    const mediaMetadata = (m.media_metadata && typeof m.media_metadata === "object")
      ? m.media_metadata as Record<string, unknown>
      : {};

    // c.1) Marca como 'enviando' (lock otimista — só atualiza se ainda for 'falha')
    const { data: lockRow, error: errLock } = await supabase
      .from("mensagens")
      .update({ status_envio: "enviando" })
      .eq("id", mensagemId)
      .eq("status_envio", "falha")
      .select("id")
      .maybeSingle();

    if (errLock || !lockRow) {
      // Outra execução já pegou, ou erro — pula
      continue;
    }

    const numero = (m as { clients?: { numero_whatsapp?: string } }).clients
      ?.numero_whatsapp?.replace(/\D/g, "");

    if (!numero) {
      const novoMeta = { ...mediaMetadata, erro_motivo: "Cliente sem número de WhatsApp" };
      await supabase.from("mensagens").update({
        status_envio: "falha",
        tentativas_envio: tentativaNum,
        media_metadata: novoMeta,
      }).eq("id", mensagemId);
      falhas++;
      log({
        funcao: FUNCAO, evento: "retry_falha", status: "erro",
        mensagem_id: mensagemId, duracao_ms: t(),
        extra: { tentativa: tentativaNum }, erro_msg: "cliente_sem_numero",
      });
      continue;
    }

    try {
      let resp: unknown;
      const tipo = m.tipo as string;
      if (tipo === "texto") {
        resp = await enviarTexto({ telefone: numero, mensagem: (m.content as string) ?? "" });
      } else {
        const tipoZapi = MAPA_TIPO_ZAPI[tipo];
        if (!tipoZapi || !m.media_url) {
          throw new Error(`Tipo de mensagem inválido para retry: ${tipo}`);
        }
        resp = await enviarMidia({
          telefone: numero,
          tipo: tipoZapi,
          url: m.media_url as string,
          caption: typeof m.content === "string" && m.content.trim() ? m.content.trim() : undefined,
          fileName: typeof mediaMetadata.nome_original === "string"
            ? (mediaMetadata.nome_original as string) : undefined,
        });
      }

      const zapiId = (resp as { messageId?: string; id?: string } | null)?.messageId
        ?? (resp as { id?: string } | null)?.id ?? null;

      // Limpa os rastros do erro: a mensagem saiu.
      const novoMeta = { ...mediaMetadata };
      delete novoMeta.erro_motivo;
      delete novoMeta.envio_incerto_em;
      delete novoMeta.envio_incerto_motivo;
      const metaFinal = Object.keys(novoMeta).length > 0 ? novoMeta : null;

      await supabase.from("mensagens").update({
        status_envio: "enviado",
        zapi_message_id: zapiId,
        tentativas_envio: tentativaNum,
        media_metadata: metaFinal,
      }).eq("id", mensagemId);

      sucessos++;
      log({
        funcao: FUNCAO, evento: "retry_sucesso", status: "ok",
        mensagem_id: mensagemId, duracao_ms: t(),
        extra: { tentativa: tentativaNum },
      });
    } catch (err) {
      const upd = atualizacaoAposErroEnvio(err, mediaMetadata);
      const motivo =
        (upd.media_metadata.erro_motivo ?? upd.media_metadata.envio_incerto_motivo) as string;
      await supabase.from("mensagens").update({
        ...upd,
        tentativas_envio: tentativaNum,
      }).eq("id", mensagemId);

      falhas++;
      log({
        funcao: FUNCAO,
        evento: upd.status_envio === "falha" ? "retry_falha" : "retry_incerto",
        status: upd.status_envio === "falha" ? "erro" : "ok",
        mensagem_id: mensagemId, duracao_ms: t(),
        extra: { tentativa: tentativaNum, erro_motivo: motivo, status_envio: upd.status_envio },
        erro_msg: motivo,
      });
    }
  }

  log({
    funcao: FUNCAO, evento: "retry_concluido", status: "ok",
    duracao_ms: cron(),
    extra: {
      sucessos,
      falhas,
      total: lista.length,
      promovidos_mensagens: promovidos.mensagens,
      promovidos_grupos: promovidos.grupos,
      promovidos_docs: promovidos.docs,
    },
  });

  return new Response(JSON.stringify({ ok: true, sucessos, falhas, total: lista.length, promovidos }), {
    headers: { "Content-Type": "application/json" },
  });
});
