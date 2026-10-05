// Edge Function: cron-notificacao-colaboradores
// Roda a cada 1min via pg_cron. Quando o toggle
// system_config.notificar_colaboradores_pendente está ligado, avisa no WhatsApp
// pessoal quem precisa atender um cliente que acabou de cair na fila:
//
//  - atendimento 'pendente'  → TODOS os colaboradores ativos do departamento.
//    Um administrador só entra nessa lista se tiver esse departamento atribuído
//    em users.department_id (admin sem departamento não recebe — ele já tem o
//    lembrete de atraso à parte).
//  - atendimento 'reservado' → SÓ o dono da reserva (assigned_to), e SÓ quando a
//    reserva foi automática. O bot reserva para o último atendente do cliente
//    naquele setor (triagem-bot finalizarTriagem/continuidade e
//    webhook-zapi-receive) e nesse caminho o atendimento nunca passa por
//    'pendente' — ninguém era avisado, porque o notificar-repasse exige um ator
//    humano. Reserva feita por gente (repasse, atribuição por admin, ou o
//    próprio colaborador clicando "atender") é filtrada aqui: ou o
//    notificar-repasse já avisou, ou a pessoa não precisa ser avisada de um
//    clique dela mesma. Ver TIPOS_EVENTO_RESERVA_HUMANA em logic.ts.
//
// Uma vez por (cliente, departamento, destino) — ledger com claim atômico.
// Respeita o kill switch (bot_ativo) — pausa junto quando o bot está off.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { botEstaAtivo } from "../_shared/kill-switch.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";
import { registrarEnvioInterno } from "../_shared/envio-interno.ts";
import { enviarTexto, ZapiError } from "../_shared/uazapi-client.ts";
import { interpolar } from "../_shared/formato.ts";
import {
  alvoDoAviso,
  colaboradorRecebe,
  departamentoNotificavel,
  indexarReservasHumanas,
  reservaFeitaPeloBot,
  soDigitos,
  telefoneExibicao,
  TIPOS_EVENTO_RESERVA_HUMANA,
} from "./logic.ts";

const FUNCAO = "cron-notificacao-colaboradores";
const LIMITE = 50;
// Menor que o intervalo do cron (60s) para um tick não invadir o próximo.
// O que sobrar é reprocessado no tick seguinte (o claim é por item).
const DEADLINE_MS = 50_000;

const STATUS_NOTIFICAVEIS = ["pendente", "reservado"];

// Piso de idade dos candidatos. Serve a dois propósitos:
//  1. "Novo cliente aguardando" não faz sentido para algo de semanas atrás —
//     atraso é assunto do cron-notificacao-admin, não deste aviso.
//  2. Impede que a janela de LIMITE seja ocupada para sempre por itens antigos.
//     Um 'reservado' não expira sozinho (o encerramento automático está off),
//     então sem o piso um punhado de reservas velhas afundaria os pendentes
//     novos silenciosamente — o ORDER BY é por created_at ASC.
const JANELA_CANDIDATOS_DIAS = 7;

const TEMPLATE_CHAVE_SETOR = "notificacao_colaborador";
const TEMPLATE_CHAVE_RESERVADO = "notificacao_colaborador_reservado";

const TEMPLATE_FALLBACK_SETOR =
  "🔔 *Novo cliente aguardando*\n\nO cliente *{{nome_cliente}}* ({{telefone}}) quer ser atendido no setor {{departamento}}.";
const TEMPLATE_FALLBACK_RESERVADO =
  "🔔 *Novo cliente pra você*\n\n*{{nome_cliente}}* ({{telefone}}) voltou e foi direcionado(a) pra você no setor {{departamento}}.";

// deno-lint-ignore no-explicit-any
type Supa = any;

interface Destino {
  whatsapp: string;
}

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

    // 3) Templates por empresa (fallback embutido se algum não existir). A chave
    // de templates_mensagem é (company_id, chave), então indexamos pelos dois —
    // buscar só por 'chave' pegaria o texto de outra empresa quando houver mais
    // de uma.
    const { data: tpls } = await supabase
      .from("templates_mensagem")
      .select("company_id, chave, texto")
      .in("chave", [TEMPLATE_CHAVE_SETOR, TEMPLATE_CHAVE_RESERVADO])
      .eq("ativo", true);
    const templates = new Map<string, string>();
    for (const t of (tpls ?? []) as { company_id: string | null; chave: string; texto: string | null }[]) {
      const texto = (t.texto ?? "").trim();
      if (texto) templates.set(`${t.company_id ?? ""}:${t.chave}`, texto);
    }
    const resolveTemplate = (companyId: string | null, chave: string, fallback: string): string =>
      templates.get(`${companyId ?? ""}:${chave}`) ?? fallback;

    // 4) Candidatos: pendentes/reservados com departamento real, antigos primeiro.
    const pisoIso = new Date(Date.now() - JANELA_CANDIDATOS_DIAS * 86_400_000).toISOString();
    const { data: candidatos, error: errSel } = await supabase
      .from("atendimentos")
      .select("id, company_id, current_department_id, status, assigned_to, is_sessao, created_at")
      .in("status", STATUS_NOTIFICAVEIS)
      .gte("created_at", pisoIso)
      .order("created_at", { ascending: true })
      .limit(LIMITE);

    if (errSel) {
      log({ funcao: FUNCAO, evento: "selecao_erro", status: "erro", duracao_ms: cron(), erro_msg: errSel.message });
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }

    // Janela cheia: pode haver candidato legítimo de fora. Não é erro (o tick
    // seguinte continua), mas precisa ser visível se virar rotina.
    if ((candidatos ?? []).length === LIMITE) {
      log({ funcao: FUNCAO, evento: "janela_saturada", status: "ok", extra: { limite: LIMITE } });
    }

    const lista = (candidatos ?? []).filter((a: { current_department_id: string | null }) =>
      departamentoNotificavel(a.current_department_id)
    );

    // Reservas com ator humano (repasse, atribuição por admin, ou o próprio
    // colaborador clicando "atender"). Uma query por tick, não por item.
    // Se essa leitura falhar, os reservados são pulados no tick — mandar sem
    // saber a origem da reserva é pior que atrasar 60s.
    const idsReservados = (lista as { id: string; status: string }[])
      .filter((a) => a.status === "reservado")
      .map((a) => a.id);
    let reservasHumanas = new Set<string>();
    let reservasConhecidas = true;
    if (idsReservados.length > 0) {
      const { data: eventos, error: errEv } = await supabase
        .from("timeline_events")
        .select("atendimento_id, target_user_id, actor_user_id")
        .in("atendimento_id", idsReservados)
        .in("tipo_evento", TIPOS_EVENTO_RESERVA_HUMANA)
        .not("actor_user_id", "is", null);
      if (errEv) {
        reservasConhecidas = false;
        log({ funcao: FUNCAO, evento: "eventos_reserva_erro", status: "erro", erro_msg: errEv.message });
      } else {
        reservasHumanas = indexarReservasHumanas(eventos ?? []);
      }
    }

    const inicioMs = Date.now();
    let enviadas = 0;
    let falhas = 0;
    let atendidos = 0;

    // Cache de colaboradores por departamento (evita reconsultar no mesmo tick).
    const colabCache = new Map<string, Destino[]>();
    const resolveColaboradores = async (deptId: string): Promise<Destino[]> => {
      if (colabCache.has(deptId)) return colabCache.get(deptId)!;
      const { data: users } = await supabase
        .from("users")
        .select("whatsapp, ativo, is_system_user")
        .eq("department_id", deptId);
      const destinos = (users ?? [])
        .filter((u: Parameters<typeof colaboradorRecebe>[0]) => colaboradorRecebe(u))
        .map((u: { whatsapp: string | null }) => ({ whatsapp: soDigitos(u.whatsapp ?? "") }));
      colabCache.set(deptId, destinos);
      return destinos;
    };

    // Dono da reserva: mesmas regras de elegibilidade (ativo, não-sistema, com
    // WhatsApp). Ignora o department_id — quem manda é a reserva.
    const donoCache = new Map<string, Destino[]>();
    const resolveDono = async (userId: string): Promise<Destino[]> => {
      if (donoCache.has(userId)) return donoCache.get(userId)!;
      const { data: dono } = await supabase
        .from("users")
        .select("whatsapp, ativo, is_system_user")
        .eq("id", userId)
        .maybeSingle();
      const destinos: Destino[] = dono && colaboradorRecebe(dono)
        ? [{ whatsapp: soDigitos(dono.whatsapp ?? "") }]
        : [];
      donoCache.set(userId, destinos);
      return destinos;
    };

    for (const at of lista) {
      if (Date.now() - inicioMs > DEADLINE_MS) {
        log({ funcao: FUNCAO, evento: "deadline_atingido", status: "ok", extra: { enviadas, falhas } });
        break;
      }
      const atId = at.id as string;
      const deptId = at.current_department_id as string;

      const alvo = alvoDoAviso(at.status as string | null, at.assigned_to as string | null);
      if (!alvo) {
        log({ funcao: FUNCAO, evento: "sem_alvo", status: "ok", atendimento_id: atId, extra: { status: at.status } });
        continue;
      }

      if (alvo.modo === "reservado") {
        // Sem saber a origem da reserva, não manda (evita duplicar o aviso de
        // repasse). O tick seguinte tenta de novo.
        if (!reservasConhecidas) {
          log({ funcao: FUNCAO, evento: "reserva_origem_indefinida", status: "ok", atendimento_id: atId });
          continue;
        }
        if (!reservaFeitaPeloBot(reservasHumanas, atId, alvo.userId)) {
          log({ funcao: FUNCAO, evento: "reserva_humana_ignorada", status: "ok", atendimento_id: atId });
          continue;
        }
        // Lista de Sessões: o fluxo interno já manda o 'sessao_confirmacao' e
        // quem "espera" é um colega, não um cliente que voltou. Fora do escopo
        // deste aviso. Pendente de sessão (setor sem colaborador) segue avisando
        // o time, como já era antes.
        if (at.is_sessao === true) {
          log({ funcao: FUNCAO, evento: "sessao_ignorada", status: "ok", atendimento_id: atId });
          continue;
        }
      }

      // Resolve destinatários ANTES do claim: se não há ninguém elegível agora,
      // não reivindicamos — assim um tick futuro tenta de novo quando alguém for
      // ativado/ganhar WhatsApp. Reivindicar aqui trancaria o item pra sempre,
      // sem janela de tempo pra se curar.
      const destinos = alvo.modo === "setor"
        ? await resolveColaboradores(deptId)
        : await resolveDono(alvo.userId);
      if (destinos.length === 0) {
        log({
          funcao: FUNCAO,
          evento: alvo.modo === "setor" ? "depto_sem_colaborador" : "dono_nao_elegivel",
          status: "ok",
          atendimento_id: atId,
          extra: { department_id: deptId, modo: alvo.modo },
        });
        continue;
      }

      // Claim atômico: no máximo 1 aviso por (atendimento, departamento, destino).
      // O destino faz parte da chave para que um reservado avisado e depois
      // liberado ao setor (release_atendimentos_on_user_inactive) ainda gere o
      // aviso ao time.
      const destinoUserId = alvo.modo === "reservado" ? alvo.userId : null;
      const { data: claim, error: errClaim } = await supabase
        .from("notificacoes_colaborador_pendente")
        .upsert(
          {
            atendimento_id: atId,
            department_id: deptId,
            company_id: at.company_id ?? null,
            destino_user_id: destinoUserId,
          },
          { onConflict: "atendimento_id,department_id,destino_user_id", ignoreDuplicates: true },
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
      const template = alvo.modo === "setor"
        ? resolveTemplate(at.company_id ?? null, TEMPLATE_CHAVE_SETOR, TEMPLATE_FALLBACK_SETOR)
        : resolveTemplate(at.company_id ?? null, TEMPLATE_CHAVE_RESERVADO, TEMPLATE_FALLBACK_RESERVADO);
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
          const resp = await enviarTexto({ telefone: destino.whatsapp, mensagem: texto });
          // Aviso interno: marca para o webhook não gravar o eco na conversa.
          await registrarEnvioInterno(FUNCAO, resp);
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
        // Nenhum destinatário recebeu: solta o claim pra tentar de novo.
        await supabase.from("notificacoes_colaborador_pendente").delete().eq("id", claimId);
      } else {
        atendidos++;
        log({
          funcao: FUNCAO,
          evento: "aviso_enviado",
          status: "ok",
          atendimento_id: atId,
          extra: { destinos: destinos.length, modo: alvo.modo },
        });
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
