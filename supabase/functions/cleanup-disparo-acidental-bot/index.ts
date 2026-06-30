// ONE-SHOT: reverte o disparo acidental do triagem-bot ocorrido em
// 2026-05-12 10:50:55–10:51:02 UTC. Apaga via Z-API as mensagens "Olá! 👋..."
// e "Para te direcionar..." do bot, exceto para clientes que ficaram pendurados
// sem atendimento desde 17:45 BRT do dia anterior (a triagem é legítima pra eles).
//
// Modos:
//   GET  /                                          → DRY-RUN
//   GET  /?confirm=true   header x-cleanup-token: $CLEANUP_CONFIRM_TOKEN
//                                                   → executa deletes
//
// Auditoria em public.cleanup_log (gravada nos dois modos com mesmo run_id).

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { deletarMensagem, ZapiError } from "../_shared/zapi-client.ts";

const JANELA_INICIO = "2026-05-12T10:45:00.000Z";
const JANELA_FIM = "2026-05-12T11:05:00.000Z";
// 17:45 BRT (UTC-3) = 20:45 UTC do dia anterior.
const INBOUND_DESDE = "2026-05-11T20:45:00.000Z";

const MANTER_FORCADO_NOMES = ["tersiane", "gecica cruz"];

const THROTTLE_MS = 200; // 5 req/s
const ABORT_PROBE = 5;
const ABORT_THRESHOLD = 4;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-cleanup-token, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function maskPhone(p: string | null): string {
  if (!p) return "";
  const tail = p.slice(-4);
  return `+${p.slice(0, 2)}****${tail}`;
}

interface Candidata {
  message_id: string;
  zapi_message_id: string;
  client_id: string;
  created_at: string;
  content: string;
  cliente_nome: string | null;
  cliente_telefone: string;
}

interface Veredicto {
  acao: "apagar" | "manter";
  motivo: string;
}

async function carregarCandidatas() {
  const sb = getSupabaseAdmin();
  // CTE feita em duas queries para evitar SQL bruto:
  // 1) candidatas com join em clients.
  const { data, error } = await sb
    .from("mensagens")
    .select(
      "id, zapi_message_id, client_id, created_at, content, clients!inner(nome, numero_whatsapp)",
    )
    .eq("sender_type", "bot")
    .eq("direction", "outbound")
    .not("zapi_message_id", "is", null)
    .gte("created_at", JANELA_INICIO)
    .lte("created_at", JANELA_FIM)
    .or("content.ilike.Olá! 👋%,content.ilike.Para te direcionar%");
  if (error) throw new Error(`select candidatas: ${error.message}`);

  const out: Candidata[] = (data ?? []).map((r) => {
    const cli = r.clients as unknown as { nome: string | null; numero_whatsapp: string };
    return {
      message_id: r.id as string,
      zapi_message_id: r.zapi_message_id as string,
      client_id: r.client_id as string,
      created_at: r.created_at as string,
      content: (r.content as string) ?? "",
      cliente_nome: cli?.nome ?? null,
      cliente_telefone: cli?.numero_whatsapp ?? "",
    };
  });
  return out;
}

async function montarVeredictos(candidatas: Candidata[]): Promise<Map<string, Veredicto>> {
  const sb = getSupabaseAdmin();
  // Para cada client_id atingido, computa t_disparo (min created_at do bot na janela).
  const tDisparoPorCliente = new Map<string, string>();
  for (const c of candidatas) {
    const atual = tDisparoPorCliente.get(c.client_id);
    if (!atual || c.created_at < atual) tDisparoPorCliente.set(c.client_id, c.created_at);
  }
  const clienteIds = Array.from(tDisparoPorCliente.keys());

  // Busca todas as mensagens desses clientes entre INBOUND_DESDE e o maior t_disparo.
  const tMax = candidatas.reduce(
    (acc, c) => (c.created_at > acc ? c.created_at : acc),
    candidatas[0]?.created_at ?? JANELA_FIM,
  );

  const { data: hist, error } = await sb
    .from("mensagens")
    .select("client_id, direction, sender_type, created_at")
    .in("client_id", clienteIds)
    .gte("created_at", INBOUND_DESDE)
    .lte("created_at", tMax)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`select histórico: ${error.message}`);

  // Por cliente: existe inbound após INBOUND_DESDE e antes de t_disparo,
  // SEM atendente entre essa inbound e t_disparo? → MANTER.
  const manterCliente = new Map<string, string>(); // client_id -> motivo

  // Exceção manual: força MANTER por substring no nome do cliente.
  for (const c of candidatas) {
    const nome = (c.cliente_nome ?? "").toLowerCase();
    if (MANTER_FORCADO_NOMES.some((s) => nome.includes(s))) {
      manterCliente.set(c.client_id, "exceção manual confirmada pelo usuário");
    }
  }
  for (const cid of clienteIds) {
    if (manterCliente.has(cid)) continue;
    const tDisp = tDisparoPorCliente.get(cid)!;
    const linhas = (hist ?? []).filter(
      (m) => m.client_id === cid && (m.created_at as string) < tDisp,
    );
    // Última inbound antes do disparo:
    let ultimaInbound: string | null = null;
    for (const m of linhas) {
      if (m.direction === "inbound") ultimaInbound = m.created_at as string;
    }
    if (!ultimaInbound) continue;
    // Houve atendente entre ultimaInbound e tDisp?
    const atendenteEntre = linhas.some(
      (m) =>
        m.sender_type === "atendente" &&
        (m.created_at as string) > ultimaInbound! &&
        (m.created_at as string) < tDisp,
    );
    if (!atendenteEntre) {
      manterCliente.set(
        cid,
        `cliente sem resposta de atendente desde inbound ${ultimaInbound}`,
      );
    }
  }

  const veredictos = new Map<string, Veredicto>();
  for (const c of candidatas) {
    const motivoManter = manterCliente.get(c.client_id);
    if (motivoManter) {
      veredictos.set(c.message_id, { acao: "manter", motivo: motivoManter });
    } else {
      veredictos.set(c.message_id, {
        acao: "apagar",
        motivo: "disparo acidental do bot em 2026-05-12 10:50 UTC",
      });
    }
  }
  return veredictos;
}

async function gravarLog(
  rows: Array<{
    run_id: string;
    message_id: string | null;
    zapi_message_id: string | null;
    client_id: string | null;
    phone: string | null;
    acao: string;
    motivo: string;
    zapi_response?: unknown;
  }>,
) {
  if (rows.length === 0) return;
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("cleanup_log").insert(rows);
  if (error) console.error("cleanup_log insert falhou:", error.message);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "GET") return json({ erro: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const confirm = url.searchParams.get("confirm") === "true";
  const tokenHeader = req.headers.get("x-cleanup-token") ?? "";
  const tokenSecret = Deno.env.get("CLEANUP_CONFIRM_TOKEN") ?? "";

  const inicio = Date.now();
  const runId = crypto.randomUUID();

  let candidatas: Candidata[];
  let veredictos: Map<string, Veredicto>;
  try {
    candidatas = await carregarCandidatas();
    veredictos = await montarVeredictos(candidatas);
  } catch (e) {
    return json({ erro: "preparacao_falhou", detalhe: (e as Error).message }, 500);
  }

  const apagar = candidatas.filter((c) => veredictos.get(c.message_id)?.acao === "apagar");
  const manter = candidatas.filter((c) => veredictos.get(c.message_id)?.acao === "manter");

  // ---------------- DRY-RUN ----------------
  if (!confirm) {
    await gravarLog(
      candidatas.map((c) => {
        const v = veredictos.get(c.message_id)!;
        return {
          run_id: runId,
          message_id: c.message_id,
          zapi_message_id: c.zapi_message_id,
          client_id: c.client_id,
          phone: c.cliente_telefone,
          acao: v.acao === "apagar" ? "dry_run_apagar" : "dry_run_manter",
          motivo: v.motivo,
        };
      }),
    );

    const amostra = (arr: Candidata[], limite?: number) =>
      (limite ? arr.slice(0, limite) : arr).map((c) => ({
        nome: c.cliente_nome,
        telefone: maskPhone(c.cliente_telefone),
        created_at: c.created_at,
        content_preview: c.content.slice(0, 60),
        motivo: veredictos.get(c.message_id)?.motivo,
      }));

    return json({
      modo: "dry_run",
      run_id: runId,
      janela: { inicio: JANELA_INICIO, fim: JANELA_FIM },
      total_candidatas: candidatas.length,
      total_a_apagar: apagar.length,
      total_a_manter: manter.length,
      amostra_apagar: amostra(apagar, 20),
      amostra_manter: amostra(manter),
      como_executar:
        "GET ?confirm=true com header 'x-cleanup-token: <CLEANUP_CONFIRM_TOKEN>'",
      consulta_auditoria: `select * from cleanup_log where run_id='${runId}' order by executed_at`,
    });
  }

  // ---------------- EXECUÇÃO ----------------
  if (!tokenSecret) {
    return json({ erro: "secret_ausente", detalhe: "CLEANUP_CONFIRM_TOKEN não configurado" }, 500);
  }
  if (tokenHeader !== tokenSecret) {
    return json({ erro: "token_invalido" }, 401);
  }

  // Registra os "manter" upfront.
  await gravarLog(
    manter.map((c) => ({
      run_id: runId,
      message_id: c.message_id,
      zapi_message_id: c.zapi_message_id,
      client_id: c.client_id,
      phone: c.cliente_telefone,
      acao: "mantida_por_regra",
      motivo: veredictos.get(c.message_id)!.motivo,
    })),
  );

  let okCount = 0;
  let falhaCount = 0;
  let probeFalhasJanela = 0;
  const falhasAmostra: Array<{ message_id: string; motivo: string }> = [];

  for (let i = 0; i < apagar.length; i++) {
    const c = apagar[i];
    let okThis = false;
    let zapiResp: unknown = null;
    let motivoFalha = "";

    try {
      zapiResp = await deletarMensagem({
        telefone: c.cliente_telefone,
        zapiMessageId: c.zapi_message_id,
      });
      okThis = true;
    } catch (err) {
      const isZapi = err instanceof ZapiError;
      motivoFalha = isZapi
        ? `HTTP ${(err as ZapiError).status}: ${(err as ZapiError).body.slice(0, 200)}`
        : (err as Error).message.slice(0, 200);
    }

    await gravarLog([
      {
        run_id: runId,
        message_id: c.message_id,
        zapi_message_id: c.zapi_message_id,
        client_id: c.client_id,
        phone: c.cliente_telefone,
        acao: okThis ? "deletada_sucesso" : "delete_falhou",
        motivo: okThis ? "ok" : motivoFalha,
        zapi_response: zapiResp,
      },
    ]);

    if (okThis) {
      okCount++;
    } else {
      falhaCount++;
      if (falhasAmostra.length < 10) {
        falhasAmostra.push({ message_id: c.message_id, motivo: motivoFalha });
      }
      // Abort guard: nas primeiras ABORT_PROBE tentativas, se ABORT_THRESHOLD
      // falharem com mensagens típicas de janela expirada → aborta.
      if (i < ABORT_PROBE) {
        const lower = motivoFalha.toLowerCase();
        if (
          lower.includes("window") ||
          lower.includes("expired") ||
          lower.includes("not found") ||
          lower.includes("not-found") ||
          lower.includes("nao encontrad") ||
          lower.includes("não encontrad")
        ) {
          probeFalhasJanela++;
          if (probeFalhasJanela >= ABORT_THRESHOLD) {
            return json(
              {
                modo: "abortado",
                run_id: runId,
                motivo:
                  "muitas falhas iniciais de janela expirada / mensagem inexistente; abortando",
                processadas: i + 1,
                ok: okCount,
                falhas: falhaCount,
                falhasAmostra,
                consulta_auditoria: `select * from cleanup_log where run_id='${runId}' order by executed_at`,
              },
              409,
            );
          }
        }
      }
    }

    if (i < apagar.length - 1) {
      await new Promise((r) => setTimeout(r, THROTTLE_MS));
    }
  }

  return json({
    modo: "executado",
    run_id: runId,
    total_candidatas: candidatas.length,
    total_mantidas: manter.length,
    total_deletadas: okCount,
    total_falhas: falhaCount,
    duracao_ms: Date.now() - inicio,
    amostra_falhas: falhasAmostra,
    consulta_auditoria: `select * from cleanup_log where run_id='${runId}' order by executed_at`,
  });
});
