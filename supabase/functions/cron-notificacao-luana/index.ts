// Edge Function: cron-notificacao-luana
// Roda a cada 5min via pg_cron. Notifica a Luana (WhatsApp pessoal + tabela
// notificacoes_luana) sobre atendimentos parados em 'pendente' por mais
// que system_config.tempo_notificacao_luana minutos. Repete a cada
// intervalo_repeticao_notificacao_luana minutos enquanto continuar pendente.
//
// Respeita kill switch (bot_ativo) e horário comercial quando
// notificacao_apenas_horario_comercial=true.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { botEstaAtivo } from "../_shared/kill-switch.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { enviarTexto, ZapiError } from "../_shared/zapi-client.ts";

const FUNCAO = "cron-notificacao-luana";
const LIMITE = 50;
const TEMPO_DEFAULT = 60;
const REPETICAO_DEFAULT = 30;

function configToInt(valor: unknown, fallback: number): number {
  const n = parseInt(String(valor ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function configToBool(valor: unknown, fallback: boolean): boolean {
  const v = String(valor ?? "").trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

function interpolar(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

Deno.serve(async (_req: Request) => {
  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  try {
    // 1) Kill switch
    const ativo = await botEstaAtivo();
    if (!ativo) {
      log({ funcao: FUNCAO, evento: "notificacao_pulada_kill_switch", status: "ok", duracao_ms: cron() });
      return new Response(JSON.stringify({ ok: true, acao: "kill_switch" }));
    }

    // 2) Configurações
    const { data: cfgs } = await supabase
      .from("system_config")
      .select("chave,valor")
      .in("chave", [
        "tempo_notificacao_luana",
        "intervalo_repeticao_notificacao_luana",
        "numero_whatsapp_luana",
        "notificacao_apenas_horario_comercial",
      ]);

    const cfgMap = new Map<string, string | null>(
      (cfgs ?? []).map((c) => [c.chave as string, (c.valor as string | null) ?? null]),
    );

    const tempoMin = configToInt(cfgMap.get("tempo_notificacao_luana"), TEMPO_DEFAULT);
    const repetMin = configToInt(cfgMap.get("intervalo_repeticao_notificacao_luana"), REPETICAO_DEFAULT);
    const numeroLuana = (cfgMap.get("numero_whatsapp_luana") ?? "").trim();
    const apenasHorarioComercial = configToBool(cfgMap.get("notificacao_apenas_horario_comercial"), true);

    // 3) Horário comercial
    if (apenasHorarioComercial) {
      const { data: hcRow } = await supabase.rpc("esta_em_horario_comercial", {
        ts: new Date().toISOString(),
      });
      if (hcRow !== true) {
        log({ funcao: FUNCAO, evento: "notificacao_pulada_fora_horario", status: "ok", duracao_ms: cron() });
        return new Response(JSON.stringify({ ok: true, acao: "fora_horario" }));
      }
    }

    // 4) Número configurado
    if (!numeroLuana) {
      log({ funcao: FUNCAO, evento: "notificacao_sem_numero_configurado", status: "ok", duracao_ms: cron() });
      return new Response(JSON.stringify({ ok: true, acao: "sem_numero" }));
    }

    // 5) Template
    const { data: tpl, error: errTpl } = await supabase
      .from("templates_mensagem")
      .select("texto,ativo")
      .eq("chave", "notificacao_luana")
      .eq("ativo", true)
      .maybeSingle();

    if (errTpl || !tpl) {
      log({ funcao: FUNCAO, evento: "template_ausente", status: "erro", duracao_ms: cron(), erro_msg: errTpl?.message ?? "sem template ativo" });
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }
    const templateTexto = tpl.texto as string;

    // 6) Candidatos: pendentes ordenados por created_at ASC
    const { data: candidatos, error: errSel } = await supabase
      .from("atendimentos")
      .select("id,created_at,client_id,current_department_id,subject_id")
      .eq("status", "pendente")
      .order("created_at", { ascending: true })
      .limit(LIMITE);

    if (errSel) {
      log({ funcao: FUNCAO, evento: "selecao_candidatos", status: "erro", duracao_ms: cron(), erro_msg: errSel.message });
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }

    const lista = candidatos ?? [];
    log({
      funcao: FUNCAO,
      evento: "notificacao_iniciada",
      status: "ok",
      extra: { candidatos: lista.length, tempo_min: tempoMin, repet_min: repetMin },
    });

    const agoraMs = Date.now();
    let enviadas = 0;
    let falhas = 0;

    for (const at of lista) {
      const atId = at.id as string;
      const createdMs = at.created_at ? new Date(at.created_at as string).getTime() : agoraMs;

      // última notificação para este atendimento
      const { data: ultima } = await supabase
        .from("notificacoes_luana")
        .select("created_at")
        .eq("atendimento_id", atId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const repeticao = !!ultima;

      let deveNotificar = false;
      if (!ultima) {
        deveNotificar = (agoraMs - createdMs) >= tempoMin * 60_000;
      } else {
        const lastMs = new Date((ultima as { created_at: string }).created_at).getTime();
        deveNotificar = (agoraMs - lastMs) >= repetMin * 60_000;
      }

      if (!deveNotificar) continue;

      // Payload (nome, telefone, dept, assunto, tempo formatado)
      const { data: payload, error: errPayload } = await supabase.rpc("payload_notificacao_luana", {
        p_atendimento_id: atId,
      });

      if (errPayload || !payload) {
        log({ funcao: FUNCAO, evento: "payload_erro", status: "erro", atendimento_id: atId, erro_msg: errPayload?.message ?? "payload nulo" });
        falhas++;
        continue;
      }

      const p = payload as {
        nome_cliente: string | null;
        telefone: string | null;
        departamento: string | null;
        assunto: string | null;
        tempo_aguardando: string | null;
      };

      const telefone = (p.telefone ?? "").trim();
      const nomeCliente = (p.nome_cliente ?? telefone ?? "Cliente").trim();
      const departamento = (p.departamento && p.departamento !== "—") ? p.departamento : "Triagem";
      const assunto = (p.assunto && p.assunto !== "—") ? p.assunto : "Sem assunto definido";
      const tempoAg = (p.tempo_aguardando ?? "").trim();

      // E.164 com '+'
      const telefoneFmt = telefone.startsWith("+") ? telefone : (telefone ? `+${telefone}` : "");

      const texto = interpolar(templateTexto, {
        nome_cliente: nomeCliente,
        telefone: telefoneFmt,
        departamento,
        assunto,
        tempo_aguardando: tempoAg,
      });

      // Insere registro PRIMEIRO (frontend mostra mesmo se Z-API falhar)
      const { data: notifIns, error: errIns } = await supabase
        .from("notificacoes_luana")
        .insert({ atendimento_id: atId, mensagem_texto: texto })
        .select("id")
        .single();

      if (errIns || !notifIns) {
        log({ funcao: FUNCAO, evento: "notificacao_insert_erro", status: "erro", atendimento_id: atId, erro_msg: errIns?.message ?? "insert nulo" });
        falhas++;
        continue;
      }

      // Z-API: número em E.164 sem '+' (padrão da lib)
      const telefoneZapi = numeroLuana.replace(/^\+/, "").replace(/\D/g, "");

      try {
        const resp = await enviarTexto({ telefone: telefoneZapi, mensagem: texto });
        const respObj = (resp ?? {}) as Record<string, unknown>;
        const zapiId = (respObj.messageId ?? respObj.id ?? respObj.zaapId ?? null) as string | number | null;
        enviadas++;
        log({
          funcao: FUNCAO,
          evento: "notificacao_enviada",
          status: "ok",
          atendimento_id: atId,
          extra: {
            repeticao,
            mensagem_id_zapi: zapiId === null ? null : String(zapiId),
            notificacao_id: notifIns.id as string,
          },
        });
      } catch (e) {
        falhas++;
        const msg = e instanceof Error ? e.message : String(e);
        const status = e instanceof ZapiError ? e.status : null;
        log({
          funcao: FUNCAO,
          evento: "notificacao_zapi_falhou",
          status: "erro",
          atendimento_id: atId,
          erro_msg: msg,
          extra: { http_status: status, repeticao, notificacao_id: notifIns.id as string },
        });
      }
    }

    log({
      funcao: FUNCAO,
      evento: "notificacao_concluida",
      status: "ok",
      duracao_ms: cron(),
      extra: { enviadas, falhas, candidatos: lista.length },
    });

    return new Response(
      JSON.stringify({ ok: true, enviadas, falhas, candidatos: lista.length }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log({ funcao: FUNCAO, evento: "excecao", status: "erro", duracao_ms: cron(), erro_msg: msg });
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }
});
