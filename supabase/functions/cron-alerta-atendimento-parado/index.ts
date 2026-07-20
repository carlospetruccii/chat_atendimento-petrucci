// Edge Function: cron-alerta-atendimento-parado
// Roda a cada 5min via pg_cron. Avisa o RESPONSÁVEL (hoje a Leticia) no WhatsApp
// pessoal quando um cliente fica sem atendimento — atendimento em 'pendente' ou
// 'em_triagem' há mais que system_config.tempo_alerta_atendimento_parado minutos
// (default 90). Repete a cada intervalo_repeticao_alerta_atendimento_parado
// minutos (default 30) enquanto continuar parado. Assim o responsável consegue
// relatar aos superiores.
//
// Respeita kill switch (bot_ativo) e horário comercial quando
// notificacao_apenas_horario_comercial=true. Alerta paralelo e independente do
// cron-notificacao-admin (destino, prazo e gatilho próprios).

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { botEstaAtivo } from "../_shared/kill-switch.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { enviarTexto, ZapiError } from "../_shared/uazapi-client.ts";

const FUNCAO = "cron-alerta-atendimento-parado";
const LIMITE = 50;
const TEMPO_DEFAULT = 90;
const REPETICAO_DEFAULT = 30;

// Responsável fixo pelo alerta (decisão "fixar a Leticia"). O NÚMERO é resolvido
// de users.whatsapp em runtime — então trocar o número no cadastro basta.
// Trocar de pessoa: sobrescreva com o system_config user_id_alerta_atendimento_parado
// (ou ajuste esta constante e redeploy).
const RESPONSAVEL_USER_ID_DEFAULT = "15d58f66-c8d5-422c-a618-d2712b9029ed"; // Leticia Vitória

const TEMPLATE_FALLBACK =
  "⏰ *Atendimento sem resposta*\n\nO cliente *{{nome_cliente}}* ({{telefone}}) está há {{tempo_aguardando}} sem atendimento no setor {{departamento}}.";

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

// Formata minutos de espera: 45 → "45 min"; 90 → "1h30"; 60 → "1h".
function formatarEspera(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${m.toString().padStart(2, "0")}`;
}

Deno.serve(async (_req: Request) => {
  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  try {
    // 1) Kill switch
    if (!(await botEstaAtivo())) {
      log({ funcao: FUNCAO, evento: "pulado_kill_switch", status: "ok", duracao_ms: cron() });
      return new Response(JSON.stringify({ ok: true, acao: "kill_switch" }));
    }

    // 2) Configurações
    const { data: cfgs } = await supabase
      .from("system_config")
      .select("chave,valor")
      .in("chave", [
        "tempo_alerta_atendimento_parado",
        "intervalo_repeticao_alerta_atendimento_parado",
        "user_id_alerta_atendimento_parado",
        "notificacao_apenas_horario_comercial",
      ]);
    const cfg = new Map<string, string | null>(
      (cfgs ?? []).map((c) => [c.chave as string, (c.valor as string | null) ?? null]),
    );

    const tempoMin = configToInt(cfg.get("tempo_alerta_atendimento_parado"), TEMPO_DEFAULT);
    const repetMin = configToInt(
      cfg.get("intervalo_repeticao_alerta_atendimento_parado"),
      REPETICAO_DEFAULT,
    );
    const apenasHorario = configToBool(cfg.get("notificacao_apenas_horario_comercial"), true);
    const responsavelId =
      (cfg.get("user_id_alerta_atendimento_parado") ?? "").trim() || RESPONSAVEL_USER_ID_DEFAULT;

    // 3) Horário comercial
    if (apenasHorario) {
      const { data: hc } = await supabase.rpc("esta_em_horario_comercial", {
        ts: new Date().toISOString(),
      });
      if (hc !== true) {
        log({ funcao: FUNCAO, evento: "pulado_fora_horario", status: "ok", duracao_ms: cron() });
        return new Response(JSON.stringify({ ok: true, acao: "fora_horario" }));
      }
    }

    // 4) Responsável + número (sempre do cadastro; nunca de payload externo)
    const { data: resp, error: errResp } = await supabase
      .from("users")
      .select("nome, whatsapp, ativo, is_system_user")
      .eq("id", responsavelId)
      .maybeSingle();

    const numeroResp = (resp?.whatsapp ?? "").replace(/\D/g, "");
    if (errResp || !resp || resp.ativo === false || resp.is_system_user === true || !numeroResp) {
      // Distingue config inválida (erro na query, ex.: uuid malformado) de "sem responsável".
      log({
        funcao: FUNCAO,
        evento: "sem_responsavel_valido",
        status: "ok",
        duracao_ms: cron(),
        erro_msg: errResp?.message,
      });
      return new Response(JSON.stringify({ ok: true, acao: "sem_responsavel" }));
    }

    // 5) Template (fallback embutido se não houver)
    const { data: tpl } = await supabase
      .from("templates_mensagem")
      .select("texto")
      .eq("chave", "alerta_atendimento_parado")
      .eq("ativo", true)
      .maybeSingle();
    const template = (tpl?.texto as string | null)?.trim() || TEMPLATE_FALLBACK;

    // 6) Candidatos: pendente/triagem parados há >= tempoMin
    const cutoffIso = new Date(Date.now() - tempoMin * 60_000).toISOString();
    const { data: candidatos, error: errSel } = await supabase
      .from("atendimentos")
      .select(
        "id, created_at, company_id, current_department_id, clients:client_id(nome, numero_whatsapp), departments:current_department_id(nome)",
      )
      .in("status", ["pendente", "em_triagem"])
      .lte("created_at", cutoffIso)
      .order("created_at", { ascending: true })
      .limit(LIMITE);

    if (errSel) {
      log({ funcao: FUNCAO, evento: "selecao_erro", status: "erro", duracao_ms: cron(), erro_msg: errSel.message });
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }

    const lista = candidatos ?? [];
    const agoraMs = Date.now();
    let enviadas = 0;
    let falhas = 0;

    // Janela de repetição atual (dedup atômico anti-corrida): alinha o "agora" a
    // blocos de repetMin minutos. O claim único (atendimento_id, janela) garante
    // no máximo 1 aviso por atendimento por janela, mesmo com execuções concorrentes.
    const janelaIso = new Date(Math.floor(agoraMs / (repetMin * 60_000)) * repetMin * 60_000).toISOString();

    for (const at of lista) {
      const atId = at.id as string;

      // Claim atômico da janela: só quem CRIA a linha segue e envia; execuções
      // concorrentes (ou o mesmo atendimento já avisado nesta janela) caem fora.
      const { data: claim, error: errClaim } = await supabase
        .from("alertas_atendimento_parado")
        .upsert(
          { atendimento_id: atId, company_id: at.company_id ?? null, janela: janelaIso },
          { onConflict: "atendimento_id,janela", ignoreDuplicates: true },
        )
        .select("id");
      if (errClaim) {
        log({ funcao: FUNCAO, evento: "ledger_claim_erro", status: "erro", atendimento_id: atId, erro_msg: errClaim.message });
        falhas++;
        continue;
      }
      if (!claim || claim.length === 0) continue; // já avisado nesta janela → dedup
      const claimId = claim[0].id as string;

      const cliente = (at as { clients?: { nome?: string | null; numero_whatsapp?: string } }).clients;
      const departamento = (at as { departments?: { nome?: string | null } }).departments;
      const telefoneCli = (cliente?.numero_whatsapp ?? "").trim();
      const nomeCliente = (cliente?.nome ?? telefoneCli ?? "Cliente").trim() || "Cliente";
      const deptNome = (departamento?.nome ?? "").trim() || "Triagem";
      const createdMs = at.created_at ? new Date(at.created_at as string).getTime() : agoraMs;
      const esperaMin = Math.max(0, Math.floor((agoraMs - createdMs) / 60_000));
      const telefoneFmt = telefoneCli
        ? (telefoneCli.startsWith("+") ? telefoneCli : `+${telefoneCli.replace(/\D/g, "")}`)
        : "";

      const texto = interpolar(template, {
        nome_cliente: nomeCliente,
        telefone: telefoneFmt,
        departamento: deptNome,
        tempo_aguardando: formatarEspera(esperaMin),
      });

      try {
        await enviarTexto({ telefone: numeroResp, mensagem: texto });
        enviadas++;
        log({ funcao: FUNCAO, evento: "alerta_enviado", status: "ok", atendimento_id: atId });
      } catch (e) {
        falhas++;
        // Envio falhou: solta o claim desta janela para reprocessar no próximo tick.
        await supabase.from("alertas_atendimento_parado").delete().eq("id", claimId);
        log({
          funcao: FUNCAO,
          evento: "alerta_envio_falhou",
          status: "erro",
          atendimento_id: atId,
          erro_msg: e instanceof Error ? e.message : String(e),
          extra: { http_status: e instanceof ZapiError ? e.status : null },
        });
      }
    }

    log({
      funcao: FUNCAO,
      evento: "concluido",
      status: "ok",
      duracao_ms: cron(),
      extra: { candidatos: lista.length, enviadas, falhas, tempo_min: tempoMin, repet_min: repetMin },
    });
    return new Response(
      JSON.stringify({ ok: true, candidatos: lista.length, enviadas, falhas }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    log({ funcao: FUNCAO, evento: "excecao", status: "erro", duracao_ms: cron(), erro_msg: e instanceof Error ? e.message : String(e) });
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }
});
