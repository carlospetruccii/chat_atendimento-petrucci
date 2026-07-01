// Edge Function: cron-retry-mensagens-falha
// Repesca mensagens outbound em status_envio='falha' e tenta reenviar via Z-API.
// Backoff por tentativa (0=imediato, 1=>=5min, 2=>=15min). Limite 50 por execução.
// Após 3 tentativas: desiste, atendente humano precisa intervir.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { botEstaAtivo } from "../_shared/kill-switch.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import {
  enviarMidia,
  enviarTexto,
  type TipoMidia,
  ZapiError,
} from "../_shared/uazapi-client.ts";

const FUNCAO = "cron-retry-mensagens-falha";
const LIMITE_POR_EXECUCAO = 50;
const MAX_TENTATIVAS = 3;

const MAPA_TIPO_ZAPI: Record<string, TipoMidia> = {
  imagem: "image",
  audio: "audio",
  video: "video",
  documento: "document",
};

function motivoLegivel(err: unknown): string {
  if (err instanceof ZapiError) {
    if (err.status === 429) return "WhatsApp indisponível (limite de requisições)";
    if (err.status === 401 || err.status === 403) return "WhatsApp recusou a credencial (verifique a conexão)";
    if (err.status === 404) return "Recurso não encontrado no WhatsApp";
    if (err.status >= 500) return "WhatsApp indisponível";
    try {
      const j = JSON.parse(err.body) as { error?: string; message?: string };
      const msg = j.error ?? j.message;
      if (msg && typeof msg === "string") return msg.slice(0, 140);
    } catch { /* ignora */ }
    if (err.status === 400) return "Dados inválidos para envio (verifique número/mídia)";
    return `Erro no envio (HTTP ${err.status})`;
  }
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || /timeout/i.test(err.message)) {
      return "Tempo esgotado ao enviar";
    }
    return err.message.slice(0, 140);
  }
  return "Falha desconhecida no envio";
}

Deno.serve(async (_req: Request) => {
  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // a) Kill switch
  if (!(await botEstaAtivo())) {
    log({ funcao: FUNCAO, evento: "retry_pulado_kill_switch", status: "ok", duracao_ms: cron() });
    return new Response(JSON.stringify({ ok: true, pulado: "kill_switch" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // b) Buscar candidatos com backoff via OR
  const agora = Date.now();
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

      // Limpa erro_motivo do media_metadata
      const novoMeta = { ...mediaMetadata };
      delete novoMeta.erro_motivo;
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
      const motivo = motivoLegivel(err);
      const novoMeta = { ...mediaMetadata, erro_motivo: motivo };
      await supabase.from("mensagens").update({
        status_envio: "falha",
        tentativas_envio: tentativaNum,
        media_metadata: novoMeta,
      }).eq("id", mensagemId);

      falhas++;
      log({
        funcao: FUNCAO, evento: "retry_falha", status: "erro",
        mensagem_id: mensagemId, duracao_ms: t(),
        extra: { tentativa: tentativaNum, erro_motivo: motivo },
        erro_msg: motivo,
      });
    }
  }

  log({
    funcao: FUNCAO, evento: "retry_concluido", status: "ok",
    duracao_ms: cron(),
    extra: { sucessos, falhas, total: lista.length },
  });

  return new Response(JSON.stringify({ ok: true, sucessos, falhas, total: lista.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
