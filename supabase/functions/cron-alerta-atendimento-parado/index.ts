// Edge Function: cron-alerta-atendimento-parado
// Roda a cada 5min via pg_cron. Avisa o RESPONSÁVEL no WhatsApp pessoal quando
// um cliente fica sem atendimento — atendimento em 'pendente'/'em_triagem' por
// mais que system_config.tempo_alerta_atendimento_parado MINUTOS ÚTEIS (default
// 90). "Minutos úteis" = tempo dentro do EXPEDIENTE DO DEPARTAMENTO do
// atendimento (respeita almoço, feriados e fim de semana). Fora do expediente
// conta 0, então cliente que chega 18h só começa a contar no próximo dia útil.
//
// Destinatário por departamento: departments.alert_recipient_user_id; se nulo,
// cai no responsável padrão (Leticia / system_config.user_id_alerta_...).
//
// Repete a cada intervalo_repeticao_alerta_atendimento_parado minutos (default
// 30) enquanto continuar parado. Respeita kill switch (bot_ativo). O gate de
// horário é feito por minutos úteis (por depto), não mais global.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { botEstaAtivo } from "../_shared/kill-switch.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { enviarTexto, ZapiError } from "../_shared/uazapi-client.ts";
import { formatarEspera, interpolar } from "../_shared/formato.ts";

const FUNCAO = "cron-alerta-atendimento-parado";
const TEMPO_DEFAULT = 90;
const REPETICAO_DEFAULT = 30;

// Responsável padrão (quando o departamento não define alert_recipient_user_id).
// O NÚMERO é resolvido de users.whatsapp em runtime.
const RESPONSAVEL_USER_ID_DEFAULT = "15d58f66-c8d5-422c-a618-d2712b9029ed"; // Leticia Vitória

const TEMPLATE_FALLBACK =
  "⏰ *Atendimento sem resposta*\n\nO cliente *{{nome_cliente}}* ({{telefone}}) está há {{tempo_aguardando}} sem atendimento no setor {{departamento}}.";

function configToInt(valor: unknown, fallback: number): number {
  const n = parseInt(String(valor ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// deno-lint-ignore no-explicit-any
type Supa = any;

interface Parado {
  atendimento_id: string;
  company_id: string | null;
  current_department_id: string | null;
  cliente_nome: string | null;
  cliente_numero: string | null;
  dept_nome: string | null;
  business_min: number;
  recipient_user_id: string | null;
}

Deno.serve(async (_req: Request) => {
  const cron = iniciarCronometro();
  const supabase: Supa = getSupabaseAdmin();

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
      ]);
    const cfg = new Map<string, string | null>(
      (cfgs ?? []).map((c: { chave: string; valor: string | null }) => [c.chave, c.valor ?? null]),
    );

    const tempoMin = configToInt(cfg.get("tempo_alerta_atendimento_parado"), TEMPO_DEFAULT);
    const repetMin = configToInt(
      cfg.get("intervalo_repeticao_alerta_atendimento_parado"),
      REPETICAO_DEFAULT,
    );
    const responsavelDefault =
      (cfg.get("user_id_alerta_atendimento_parado") ?? "").trim() || RESPONSAVEL_USER_ID_DEFAULT;

    // 3) Template (fallback embutido se não houver)
    const { data: tpl } = await supabase
      .from("templates_mensagem")
      .select("texto")
      .eq("chave", "alerta_atendimento_parado")
      .eq("ativo", true)
      .maybeSingle();
    const template = (tpl?.texto as string | null)?.trim() || TEMPLATE_FALLBACK;

    // 4) Candidatos: parados há >= tempoMin MINUTOS ÚTEIS (cálculo no banco por
    // departamento). Já vem com o destinatário resolvido.
    const { data: candidatos, error: errSel } = await supabase.rpc("get_atendimentos_parados", {
      p_tempo_min: tempoMin,
    });

    if (errSel) {
      log({ funcao: FUNCAO, evento: "selecao_erro", status: "erro", duracao_ms: cron(), erro_msg: errSel.message });
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }

    const lista = (candidatos ?? []) as Parado[];
    const agoraMs = Date.now();
    let enviadas = 0;
    let falhas = 0;

    // Cache de número por destinatário (evita reconsultar users no mesmo tick).
    const numeroCache = new Map<string, string | null>();
    const resolveNumero = async (userId: string): Promise<string | null> => {
      if (numeroCache.has(userId)) return numeroCache.get(userId) ?? null;
      const { data: u } = await supabase
        .from("users")
        .select("whatsapp, ativo, is_system_user")
        .eq("id", userId)
        .maybeSingle();
      const numero = (u?.whatsapp ?? "").replace(/\D/g, "");
      const valido = !!u && u.ativo !== false && u.is_system_user !== true && !!numero;
      const val = valido ? numero : null;
      numeroCache.set(userId, val);
      return val;
    };

    // Janela de repetição atual (dedup atômico anti-corrida): blocos de repetMin.
    const janelaIso = new Date(Math.floor(agoraMs / (repetMin * 60_000)) * repetMin * 60_000).toISOString();

    // Deadline auto-imposto: não estoura o tempo do gateway se a uazapi travar.
    // O que sobrar é reprocessado no próximo tick (claim é por item/janela).
    const DEADLINE_MS = 120_000;

    for (const at of lista) {
      if (Date.now() - agoraMs > DEADLINE_MS) {
        log({ funcao: FUNCAO, evento: "deadline_atingido", status: "ok", extra: { enviadas, falhas } });
        break;
      }
      const atId = at.atendimento_id;

      // Claim atômico da janela: no máximo 1 aviso por atendimento por janela.
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
      if (!claim || claim.length === 0) continue; // já avisado nesta janela
      const claimId = claim[0].id as string;

      // Destinatário do departamento; se não tiver número válido (ex.: Larissa
      // sem WhatsApp), cai no responsável padrão pra o alerta não sumir.
      let recipientId = (at.recipient_user_id ?? "").trim() || responsavelDefault;
      let numeroResp = await resolveNumero(recipientId);
      if (!numeroResp && recipientId !== responsavelDefault) {
        log({
          funcao: FUNCAO,
          evento: "destinatario_fallback",
          status: "ok",
          atendimento_id: atId,
          extra: { recipient_user_id: recipientId, fallback: responsavelDefault },
        });
        recipientId = responsavelDefault;
        numeroResp = await resolveNumero(recipientId);
      }
      if (!numeroResp) {
        // Nem o destinatário do depto nem o padrão têm número. Mantém o claim da
        // janela (não fica reenviando toda hora) e loga para diagnóstico.
        log({
          funcao: FUNCAO,
          evento: "destinatario_sem_numero",
          status: "ok",
          atendimento_id: atId,
          extra: { recipient_user_id: recipientId },
        });
        continue;
      }

      const telefoneCli = (at.cliente_numero ?? "").trim();
      const nomeCliente = (at.cliente_nome ?? telefoneCli ?? "Cliente").trim() || "Cliente";
      const deptNome = (at.dept_nome ?? "").trim() || "Triagem";
      const telefoneFmt = telefoneCli
        ? (telefoneCli.startsWith("+") ? telefoneCli : `+${telefoneCli.replace(/\D/g, "")}`)
        : "";

      const texto = interpolar(template, {
        nome_cliente: nomeCliente,
        telefone: telefoneFmt,
        departamento: deptNome,
        tempo_aguardando: formatarEspera(Math.max(0, at.business_min ?? 0)),
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
