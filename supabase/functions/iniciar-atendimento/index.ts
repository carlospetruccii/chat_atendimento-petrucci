// Edge Function: iniciar-atendimento
// Cria atendimento manual disparado pelo atendente (caminho inverso: empresa → cliente).
// Auth: JWT obrigatório.
// Não envia mensagem. Não passa por triagem. Não chama Z-API.

import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { iniciarCronometro, log } from "../_shared/logger.ts";

const FUNCAO = "iniciar-atendimento";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STATUS_ATIVOS = ["em_triagem", "reservado", "pendente", "em_atendimento"];

interface Payload {
  client_id?: string;
  department_id?: string | null;
  assigned_to?: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "method_not_allowed" }, 405);

  const cron = iniciarCronometro();
  const supabase = getSupabaseAdmin();

  // Auth
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!jwt) return json({ ok: false, erro: "unauthorized" }, 401);

  const { data: userRes, error: errUser } = await supabase.auth.getUser(jwt);
  if (errUser || !userRes?.user) return json({ ok: false, erro: "unauthorized" }, 401);
  const callerId = userRes.user.id;

  let payload: Payload;
  try {
    payload = (await req.json()) as Payload;
  } catch {
    return json({ ok: false, erro: "payload_invalido" }, 400);
  }

  const clientId = payload.client_id?.trim();
  if (!clientId) return json({ ok: false, erro: "client_id_obrigatorio" }, 400);

  // Carrega chamador + permissão view_all_departments
  const [{ data: caller }, { data: callerPerm }] = await Promise.all([
    supabase
      .from("users")
      .select("id, nome, department_id, is_superadmin, ativo")
      .eq("id", callerId)
      .maybeSingle(),
    supabase
      .from("user_permissions")
      .select("permission")
      .eq("user_id", callerId)
      .eq("permission", "view_all_departments")
      .maybeSingle(),
  ]);

  if (!caller || !caller.ativo) return json({ ok: false, erro: "caller_invalido" }, 403);

  const canChooseDept = !!caller.is_superadmin || !!callerPerm;

  // Resolve depto + assigned_to
  let departmentId: string | null;
  let assignedTo: string;

  if (canChooseDept) {
    if (!payload.department_id || !payload.assigned_to) {
      return json(
        { ok: false, erro: "campos_obrigatorios", detalhe: "department_id e assigned_to são obrigatórios" },
        400,
      );
    }
    departmentId = payload.department_id;
    assignedTo = payload.assigned_to;

    // Valida assigned_to
    const { data: alvo } = await supabase
      .from("users")
      .select("id, nome, department_id, ativo, disponivel, is_system_user")
      .eq("id", assignedTo)
      .maybeSingle();
    if (
      !alvo ||
      alvo.is_system_user ||
      !alvo.ativo ||
      !alvo.disponivel ||
      alvo.department_id !== departmentId
    ) {
      return json({ ok: false, erro: "assigned_to_invalido" }, 400);
    }
  } else {
    if (!caller.department_id) {
      return json({ ok: false, erro: "caller_sem_departamento" }, 400);
    }
    departmentId = caller.department_id;
    assignedTo = callerId;
  }

  // Valida cliente existe
  const { data: cliente } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .maybeSingle();
  if (!cliente) return json({ ok: false, erro: "cliente_nao_encontrado" }, 404);

  // Atendimento ativo?
  const { data: ativo } = await supabase
    .from("atendimentos")
    .select(
      "id, status, assigned_to, current_department_id, " +
        "assigned:users!atendimentos_assigned_to_fkey(id, nome), " +
        "department:departments!atendimentos_current_department_id_fkey(id, nome)",
    )
    .eq("client_id", clientId)
    .in("status", STATUS_ATIVOS)
    .limit(1)
    .maybeSingle();

  if (ativo) {
    const aUser = (ativo as { assigned: { nome: string } | null }).assigned;
    const aDept = (ativo as { department: { nome: string } | null }).department;
    log({
      funcao: FUNCAO,
      evento: "conflito_atendimento_ativo",
      status: "ok",
      duracao_ms: cron(),
      atendimento_id: ativo.id as string,
      client_id: clientId,
    });
    return json(
      {
        ok: false,
        error: "cliente_com_atendimento_ativo",
        atendimento_id: ativo.id,
        status: ativo.status,
        assigned_to_nome: aUser?.nome ?? "Não atribuído",
        department_nome: aDept?.nome ?? "—",
      },
      409,
    );
  }

  // Resolve nomes para payload da timeline
  const { data: deptRow } = await supabase
    .from("departments")
    .select("nome")
    .eq("id", departmentId)
    .maybeSingle();
  const { data: assignedRow } =
    assignedTo === callerId
      ? { data: { nome: caller.nome } }
      : await supabase.from("users").select("nome").eq("id", assignedTo).maybeSingle();

  const now = new Date().toISOString();

  // Cria atendimento
  const { data: novo, error: errIns } = await supabase
    .from("atendimentos")
    .insert({
      client_id: clientId,
      status: "em_atendimento",
      current_department_id: departmentId,
      assigned_to: assignedTo,
      assigned_at: now,
      subject_id: null,
      triagem_estagio: "concluida",
      triagem_started_at: now,
      triagem_finished_at: now,
      first_response_at: null,
    })
    .select("id, client_id")
    .single();

  if (errIns || !novo) {
    log({
      funcao: FUNCAO,
      evento: "insert_atendimento_erro",
      status: "erro",
      duracao_ms: cron(),
      erro_msg: errIns?.message,
    });
    return json({ ok: false, erro: "erro_interno", detalhe: errIns?.message }, 500);
  }

  // Timeline
  await supabase.from("timeline_events").insert({
    atendimento_id: novo.id,
    tipo_evento: "iniciado_atendimento",
    actor_user_id: callerId,
    target_user_id: assignedTo,
    to_department_id: departmentId,
    payload: {
      origem: "iniciar_atendimento_manual",
      criado_por_nome: caller.nome,
      atribuido_a_nome: assignedRow?.nome ?? null,
      departamento_nome: deptRow?.nome ?? null,
    },
  });

  log({
    funcao: FUNCAO,
    evento: "atendimento_criado",
    status: "ok",
    duracao_ms: cron(),
    atendimento_id: novo.id as string,
    client_id: clientId,
  });

  return json({ ok: true, atendimento_id: novo.id, client_id: novo.client_id });
});
