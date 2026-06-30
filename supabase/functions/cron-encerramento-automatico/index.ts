// Edge Function: cron-encerramento-automatico
// Roda a cada 30min via pg_cron. Encerra silenciosamente atendimentos
// em status 'em_atendimento' ou 'reservado' que estão sem atividade
// (last_message_at) há mais que system_config.tempo_encerramento_automatico
// minutos (default 1440 = 24h).
//
// NÃO envia mensagem ao cliente. NÃO toca em em_triagem (regra própria
// da triagem-bot) nem em pendente (cliente ainda esperando alguém pegar).

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { botEstaAtivo } from "../_shared/kill-switch.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";

const FUNCAO = "cron-encerramento-automatico";
const LIMITE_POR_EXECUCAO = 200;
const TEMPO_DEFAULT_MIN = 1440;

Deno.serve(async (_req: Request) => {
  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  try {
    // 1) Kill switch
    const ativo = await botEstaAtivo();
    if (!ativo) {
      log({ funcao: FUNCAO, evento: "encerramento_pulado_kill_switch", status: "ok", duracao_ms: cron() });
      return new Response(JSON.stringify({ ok: true, acao: "kill_switch" }));
    }

    // 2) Tempo configurado
    const { data: cfgRow } = await supabase
      .from("system_config")
      .select("valor")
      .eq("chave", "tempo_encerramento_automatico")
      .maybeSingle();

    const tempoMin = (() => {
      const v = parseInt(((cfgRow?.valor ?? "") as string).trim(), 10);
      return Number.isFinite(v) && v > 0 ? v : TEMPO_DEFAULT_MIN;
    })();

    const agoraMs = Date.now();
    const cutoffIso = new Date(agoraMs - tempoMin * 60_000).toISOString();

    // 3) Candidatos
    const { data: candidatos, error: errSel } = await supabase
      .from("atendimentos")
      .select("id,status,assigned_to,last_message_at")
      .in("status", ["em_atendimento", "reservado"])
      .lt("last_message_at", cutoffIso)
      .limit(LIMITE_POR_EXECUCAO);

    if (errSel) {
      log({ funcao: FUNCAO, evento: "selecao_candidatos", status: "erro", duracao_ms: cron(), erro_msg: errSel.message });
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }

    const lista = candidatos ?? [];
    log({
      funcao: FUNCAO,
      evento: "encerramento_iniciado",
      status: "ok",
      extra: { tempo_minutos: tempoMin, candidatos: lista.length },
    });

    let encerrados = 0;
    for (const at of lista) {
      const lastMs = at.last_message_at ? new Date(at.last_message_at as string).getTime() : agoraMs;
      const silencioMin = Math.round((agoraMs - lastMs) / 60_000);
      const statusAnterior = at.status as string;

      const { error: errUpd } = await supabase
        .from("atendimentos")
        .update({
          status: "encerrado",
          closed_at: new Date().toISOString(),
          close_reason: "automatico_inatividade",
          closed_by_user_id: null,
          triagem_estagio: "concluida",
        })
        .eq("id", at.id as string);

      if (errUpd) {
        log({
          funcao: FUNCAO,
          evento: "atendimento_encerrar_erro",
          status: "erro",
          atendimento_id: at.id as string,
          erro_msg: errUpd.message,
        });
        continue;
      }

      encerrados++;
      log({
        funcao: FUNCAO,
        evento: "atendimento_encerrado",
        status: "ok",
        atendimento_id: at.id as string,
        extra: {
          tempo_silencio_min: silencioMin,
          status_anterior: statusAnterior,
          assigned_to: (at.assigned_to as string | null) ?? null,
        },
      });
    }

    log({
      funcao: FUNCAO,
      evento: "encerramento_concluido",
      status: "ok",
      duracao_ms: cron(),
      extra: { total_encerrados: encerrados, candidatos: lista.length },
    });

    return new Response(
      JSON.stringify({ ok: true, encerrados, candidatos: lista.length }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log({ funcao: FUNCAO, evento: "excecao", status: "erro", duracao_ms: cron(), erro_msg: msg });
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }
});
