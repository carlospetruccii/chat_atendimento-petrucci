// Edge Function: alterar-papel-colaborador
// Troca o papel de um colaborador já existente entre 'administrador' e
// 'colaborador'. Só o DONO da empresa pode chamar (bate com a RLS de
// company_members, onde apenas o dono promove/rebaixa admin).
//
// Mantém as DUAS fontes consistentes numa só operação:
//   - users.is_superadmin  → é o que libera (ou tranca) o acesso de admin.
//   - users.department_id  → null para admin, obrigatório para colaborador.
//   - company_members.role → papel canônico (+ department_id espelhado).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { Papel, resolverTrocaPapel } from "./logic.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json(401, { error: "Não autenticado" });

  // Identifica o chamador pela sessão.
  const callerClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userRes, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !userRes.user) return json(401, { error: "Sessão inválida" });
  const callerId = userRes.user.id;

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Empresa e papel do chamador (single-tenant: uma membership ativa por pessoa).
  const { data: callerMember, error: callerErr } = await admin
    .from("company_members")
    .select("company_id, role")
    .eq("user_id", callerId)
    .eq("ativo", true)
    .maybeSingle();
  if (callerErr) {
    console.error("[alterar-papel-colaborador] leitura do chamador falhou:", callerErr.message);
    return json(503, { error: "Serviço indisponível. Tente novamente." });
  }
  const companyId = callerMember?.company_id as string | undefined;
  const callerRole = (callerMember?.role ?? null) as Papel | null;

  let body: { user_id?: string; role?: string; department_id?: string | null };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "JSON inválido" });
  }
  const targetId = (body.user_id ?? "").trim();
  if (!targetId) return json(400, { error: "user_id é obrigatório" });
  if (!companyId) return json(400, { error: "Empresa do chamador não encontrada" });

  // Estado atual do alvo, restrito à empresa do chamador.
  const { data: targetMember, error: targetErr } = await admin
    .from("company_members")
    .select("role")
    .eq("user_id", targetId)
    .eq("company_id", companyId)
    .eq("ativo", true)
    .maybeSingle();
  if (targetErr) {
    console.error("[alterar-papel-colaborador] leitura do alvo falhou:", targetErr.message);
    return json(503, { error: "Serviço indisponível. Tente novamente." });
  }

  const decisao = resolverTrocaPapel({
    callerRole,
    callerId,
    targetId,
    targetExists: !!targetMember,
    targetRole: (targetMember?.role ?? null) as Papel | null,
    novoRole: (body.role ?? "").trim(),
    departmentId: body.department_id ?? null,
  });
  if (!decisao.ok) return json(decisao.status, { error: decisao.error });

  const { isAdmin, departmentId } = decisao;

  // Escreve users + company_members numa única transação (RPC). Evita estado
  // inconsistente entre o gate de acesso e o papel canônico.
  const { error: rpcErr } = await admin.rpc("alterar_papel_membro", {
    p_user_id: targetId,
    p_company_id: companyId,
    p_is_admin: isAdmin,
    p_department_id: departmentId,
  });
  if (rpcErr) {
    // Detalhe do banco fica só no log; cliente recebe mensagem genérica.
    console.error("[alterar-papel-colaborador] rpc falhou:", rpcErr.message);
    return json(400, { error: "Falha ao alterar o papel do colaborador." });
  }

  return json(200, { user_id: targetId, role: isAdmin ? "administrador" : "colaborador" });
});
