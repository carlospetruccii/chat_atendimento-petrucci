// Edge Function: cron-bot-reactivation
// Roda 1x/dia. Se system_config.bot_ativacao_programada já chegou ou passou,
// reativa o bot (bot_ativo=true), zera o agendamento e registra auditoria.
// Sem auth externa: chamada por pg_cron interno.
//
// Auditoria: NÃO inserimos manualmente em config_audit_log. Toda escrita em
// system_config é feita via RPC public.cron_reativar_bot(), que define
// request.jwt.claims.sub = UUID do usuário Sistema na mesma transação dos
// UPDATEs. Assim o trigger genérico log_config_change registra o autor como
// Sistema (em vez de NULL) — uma única linha por campo alterado.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { invalidarCacheBotAtivo } from "../_shared/kill-switch.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";

const FUNCAO = "cron-bot-reactivation";

Deno.serve(async (_req: Request) => {
  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  try {
    // 1) Lê o agendamento atual.
    const { data: rowAgendado, error: errAgendado } = await supabase
      .from("system_config")
      .select("valor")
      .eq("chave", "bot_ativacao_programada")
      .maybeSingle();

    if (errAgendado) {
      log({
        funcao: FUNCAO,
        evento: "leitura_agendamento",
        status: "erro",
        duracao_ms: cron(),
        erro_msg: errAgendado.message,
      });
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }

    const valorAgendado = (rowAgendado?.valor ?? "").toString().trim();

    if (!valorAgendado) {
      log({
        funcao: FUNCAO,
        evento: "nenhum_agendamento",
        status: "ok",
        duracao_ms: cron(),
      });
      return new Response(JSON.stringify({ ok: true, acao: "nenhum_agendamento" }));
    }

    const dataProgramada = new Date(valorAgendado);
    if (Number.isNaN(dataProgramada.getTime())) {
      log({
        funcao: FUNCAO,
        evento: "agendamento_invalido",
        status: "erro",
        duracao_ms: cron(),
        extra: { valor_bruto: valorAgendado },
      });
      return new Response(JSON.stringify({ ok: false, acao: "agendamento_invalido" }), { status: 422 });
    }

    const agora = new Date();
    if (dataProgramada.getTime() > agora.getTime()) {
      log({
        funcao: FUNCAO,
        evento: "agendamento_futuro_aguardando",
        status: "ok",
        duracao_ms: cron(),
        extra: { agendado_para: dataProgramada.toISOString() },
      });
      return new Response(JSON.stringify({ ok: true, acao: "agendamento_futuro" }));
    }

    // 2) Reativa via RPC: a função SQL define o autor (request.jwt.claims.sub)
    //    como o usuário Sistema e roda os 2 UPDATEs na mesma transação,
    //    garantindo que o trigger log_config_change registre user_id correto.
    const { data: rpcResult, error: errRpc } = await supabase.rpc("cron_reativar_bot");

    if (errRpc) {
      log({
        funcao: FUNCAO,
        evento: "rpc_cron_reativar_bot",
        status: "erro",
        duracao_ms: cron(),
        erro_msg: errRpc.message,
      });
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }

    const valorAnteriorBot = (rpcResult as { valor_anterior_bot?: string } | null)?.valor_anterior_bot ?? "";
    const agendamentoAnterior = (rpcResult as { agendamento_anterior?: string } | null)?.agendamento_anterior ?? valorAgendado;

    // 3) Invalida cache do kill-switch para refletir imediatamente.
    invalidarCacheBotAtivo();

    log({
      funcao: FUNCAO,
      evento: "reativacao_executada",
      status: "ok",
      duracao_ms: cron(),
      extra: {
        valor_anterior_bot: valorAnteriorBot,
        agendamento_anterior: agendamentoAnterior,
      },
    });

    return new Response(
      JSON.stringify({ ok: true, acao: "reativado" }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log({
      funcao: FUNCAO,
      evento: "excecao",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: msg,
    });
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }
});
