// Edge Function: criar-colaborador
// Cria um usuário no Supabase Auth + linha em public.users.
// Apenas superadmin OU usuário com permissão 'manage_users' pode chamar.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

  // Verifica caller
  const callerClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userRes, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !userRes.user) return json(401, { error: "Sessão inválida" });
  const callerId = userRes.user.id;

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: callerRow } = await admin
    .from("users")
    .select("is_superadmin")
    .eq("id", callerId)
    .maybeSingle();

  let allowed = callerRow?.is_superadmin === true;
  if (!allowed) {
    const { data: perm } = await admin
      .from("user_permissions")
      .select("permission")
      .eq("user_id", callerId)
      .eq("permission", "manage_users")
      .maybeSingle();
    allowed = !!perm;
  }
  if (!allowed) return json(403, { error: "Sem permissão para criar colaboradores" });

  let body: { nome?: string; email?: string; password?: string; department_id?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "JSON inválido" });
  }
  const nome = body.nome?.trim();
  const email = body.email?.trim().toLowerCase();
  const password = body.password;
  const department_id = body.department_id;

  if (!nome || !email || !password || !department_id) {
    return json(400, { error: "Campos obrigatórios: nome, email, password, department_id" });
  }
  if (password.length < 8) return json(400, { error: "Senha deve ter pelo menos 8 caracteres" });

  // Cria no Auth
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    return json(400, { error: createErr?.message ?? "Falha ao criar usuário no Auth" });
  }
  const newId = created.user.id;

  // Insere em public.users
  const { error: insertErr } = await admin.from("users").insert({
    id: newId,
    nome,
    email,
    department_id,
    ativo: true,
    disponivel: true,
    is_superadmin: false,
    is_system_user: false,
  });

  if (insertErr) {
    // rollback Auth
    await admin.auth.admin.deleteUser(newId);
    return json(400, { error: `Falha ao criar registro: ${insertErr.message}` });
  }

  return json(200, { id: newId, nome, email });
});
