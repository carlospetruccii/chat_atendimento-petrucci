// Edge Function: cron-notificacao-colaboradores
// Roda a cada 1min via pg_cron. Quando o toggle
// system_config.notificar_colaboradores_pendente está ligado, avisa no WhatsApp
// pessoal TODOS os colaboradores ativos do departamento sempre que um cliente
// cai como 'pendente' naquele departamento. Nunca avisa o admin (ele já recebe
// o lembrete de atraso). Uma vez por cliente por departamento (ledger com claim
// atômico). Respeita o kill switch (bot_ativo) — pausa junto quando o bot está off.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { botEstaAtivo } from "../_shared/kill-switch.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { enviarTexto, ZapiError } from "../_shared/uazapi-client.ts";
import { interpolar } from "../_shared/formato.ts";
import { colaboradorRecebe, departamentoNotificavel, soDigitos, telefoneExibicao } from "./logic.ts";

const FUNCAO = "cron-notificacao-colaboradores";
const LIMITE = 50;
// Menor que o intervalo do cron (60s) para um tick não invadir o próximo.
// O que sobrar é reprocessado no tick seguinte (o claim é por item).
const DEADLINE_MS = 50_000;

const TEMPLATE_FALLBACK =
  "🔔 *Novo cliente aguardando*\n\nO cliente *{{nome_cliente}}* ({{telefone}}) quer ser atendido no setor {{departamento}}.";

// deno-lint-ignore no-explicit-any
type Supa = any;

function configToBool(valor: unknown, fallback: boolean): boolean {
  const v = String(valor ?? "").trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

Deno.serve(async (_req: Request) => {
  const cron = iniciarCronometro();
  const supabase: Supa = getSupabaseAdmin();

  try {
    // 1) Toggle liga/desliga
    const { data: cfgToggle } = await supabase
      .from("system_config")
      .select("valor")
      .eq("chave", "notificar_colaboradores_pendente")
      .maybeSingle();
    if (!configToBool(cfgToggle?.valor, false)) {
      log({ funcao: FUNCAO, evento: "pulado_toggle_off", status: "ok", duracao_ms: cron() });
      return new Response(JSON.stringify({ ok: true, acao: "toggle_off" }));
    }

    // 2) Kill switch (pausa junto com o bot)
    if (!(await botEstaAtivo())) {
      log({ funcao: FUNCAO, evento: "pulado_kill_switch", status: "ok", duracao_ms: cron() });
      return new Response(JSON.stringify({ ok: true, acao: "kill_switch" }));
    }

    // 3) Template (fallback embutido se não houver)
    const { data: tpl } = await supabase
      .from("templates_mensagem")
      .select("texto")
      .eq("chave", "notificacao_colaborador")
      .eq("ativo", true)
      .maybeSingle();
    const template = (tpl?.texto as string | null)?.trim() || TEMPLATE_FALLBACK;

    // 4) Candidatos: pendentes com departamento real, mais antigos primeiro.
    const { data: candidatos, error: errSel } = await supabase
      .from("atendimentos")
      .select("id, company_id, current_department_id, created_at")
      .eq("status", "pendente")
      .order("created_at", { ascending: true })
      .limit(LIMITE);

    if (errSel) {
      log({ funcao: FUNCAO, evento: "selecao_erro", status: "erro", duracao_ms: cron(), erro_msg: errSel.message });
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }

    const lista = (candidatos ?? []).filter((a: { current_department_id: string | null }) =>
      departamentoNotificavel(a.current_department_id)
    );

    const inicioMs = Date.now();
    let enviadas = 0;
    let falhas = 0;
    let atendidos = 0;

    // Cache de colaboradores por departamento (evita reconsultar no mesmo tick).
    const colabCache = new Map<string, { whatsapp: string }[]>();
    const resolveColaboradores = async (deptId: string): Promise<{ whatsapp: string }[]> => {
      if (colabCache.has(deptId)) return colabCache.get(deptId)!;
      const { data: users } = await supabase
        .from("users")
        .select("whatsapp, ativo, is_system_user, is_superadmin")
        .eq("department_id", deptId);
      const destinos = (users ?? [])
        .filter((u: Parameters<typeof colaboradorRecebe>[0]) => colaboradorRecebe(u))
        .map((u: { whatsapp: string | null }) => ({ whatsapp: soDigitos(u.whatsapp ?? "") }));
      colabCache.set(deptId, destinos);
      return destinos;
    };

    for (const at of lista) {
      if (Date.now() - inicioMs > DEADLINE_MS) {
        log({ funcao: FUNCAO, evento: "deadline_atingido", status: "ok", extra: { enviadas, falhas } });
        break;
      }
      const atId = at.id as string;
      const deptId = at.current_department_id as string;

      // Resolve colaboradores ANTES do claim: se o departamento não tem ninguém
      // elegível agora, não reivindicamos — assim um tick futuro tenta de novo
      // quando alguém for ativado/ganhar WhatsApp. Reivindicar aqui trancaria o
      // par (atendimento, depto) pra sempre, sem janela de tempo pra se curar.
      const destinos = await resolveColaboradores(deptId);
      if (destinos.length === 0) {
        log({ funcao: FUNCAO, evento: "depto_sem_colaborador", status: "ok", atendimento_id: atId, extra: { department_id: deptId } });
        continue;
      }

      // Claim atômico: no máximo 1 aviso por (atendimento, departamento).
      const { data: claim, error: errClaim } = await supabase
        .from("notificacoes_colaborador_pendente")
        .upsert(
          { atendimento_id: atId, department_id: deptId, company_id: at.company_id ?? null },
          { onConflict: "atendimento_id,department_id", ignoreDuplicates: true },
        )
        .select("id");
      if (errClaim) {
        log({ funcao: FUNCAO, evento: "ledger_claim_erro", status: "erro", atendimento_id: atId, erro_msg: errClaim.message });
        falhas++;
        continue;
      }
      if (!claim || claim.length === 0) continue; // já avisado
      const claimId = claim[0].id as string;

      // Dados do cliente/departamento (reaproveita a RPC do aviso ao admin).
      const { data: payload, error: errPayload } = await supabase.rpc("payload_notificacao_admin", {
        p_atendimento_id: atId,
      });
      if (errPayload || !payload) {
        // Solta o claim para reprocessar no próximo tick.
        await supabase.from("notificacoes_colaborador_pendente").delete().eq("id", claimId);
        log({ funcao: FUNCAO, evento: "payload_erro", status: "erro", atendimento_id: atId, erro_msg: errPayload?.message ?? "payload nulo" });
        falhas++;
        continue;
      }
      const p = payload as {
        nome_cliente: string | null;
        telefone: string | null;
        departamento: string | null;
      };
      const telefoneCli = (p.telefone ?? "").trim();
      const texto = interpolar(template, {
        nome_cliente: (p.nome_cliente ?? telefoneCli ?? "Cliente").trim() || "Cliente",
        telefone: telefoneExibicao(telefoneCli),
        departamento: (p.departamento && p.departamento !== "—") ? p.departamento : "seu setor",
      });

      let algumEnviado = false;
      for (const destino of destinos) {
        if (Date.now() - inicioMs > DEADLINE_MS) {
          log({ funcao: FUNCAO, evento: "deadline_no_envio", status: "ok", atendimento_id: atId });
          break;
        }
        try {
          await enviarTexto({ telefone: destino.whatsapp, mensagem: texto });
          enviadas++;
          algumEnviado = true;
        } catch (e) {
          falhas++;
          log({
            funcao: FUNCAO,
            evento: "envio_falhou",
            status: "erro",
            atendimento_id: atId,
            erro_msg: e instanceof Error ? e.message : String(e),
            extra: { http_status: e instanceof ZapiError ? e.status : null },
          });
        }
      }

      if (!algumEnviado) {
        // Nenhum colaborador recebeu: solta o claim pra tentar de novo.
        await supabase.from("notificacoes_colaborador_pendente").delete().eq("id", claimId);
      } else {
        atendidos++;
        log({ funcao: FUNCAO, evento: "aviso_enviado", status: "ok", atendimento_id: atId, extra: { destinos: destinos.length } });
      }
    }

    log({
      funcao: FUNCAO,
      evento: "concluido",
      status: "ok",
      duracao_ms: cron(),
      extra: { candidatos: lista.length, atendidos, enviadas, falhas },
    });
    return new Response(
      JSON.stringify({ ok: true, candidatos: lista.length, atendidos, enviadas, falhas }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    log({ funcao: FUNCAO, evento: "excecao", status: "erro", duracao_ms: cron(), erro_msg: e instanceof Error ? e.message : String(e) });
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }
});
