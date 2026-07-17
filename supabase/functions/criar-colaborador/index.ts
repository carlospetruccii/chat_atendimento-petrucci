// Edge Function: criar-colaborador
// Cria um usuário no Supabase Auth + linha em public.users + company_members.
// Apenas superadmin OU usuário com permissão 'manage_users' pode chamar.
//
// Papéis (single-tenant; seguem dono/administrador/colaborador):
//   - 'administrador' → is_superadmin = true, sem departamento (enxerga tudo).
//   - 'colaborador'   → is_superadmin = false, departamento obrigatório.
// A pessoa entra com uma senha TEMPORÁRIA e é obrigada a trocá-la no 1º acesso
// (marcador em user_metadata.must_change_password = true).
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

// Normaliza um número para E.164 (+55...). Sem DDI, assume Brasil para 10–11
// dígitos. Retorna null se não formar um E.164 válido (mesma regra da CHECK).
function normalizarE164(input: string): string | null {
  const trimmed = (input ?? "").trim();
  // Idempotente: se já é E.164 válido, devolve como está (não re-prefixa DDI).
  if (/^\+[1-9][0-9]{7,14}$/.test(trimmed)) return trimmed;
  let d = trimmed.replace(/\D/g, "");
  d = d.replace(/^0+/, "");
  if (!d) return null;
  if (d.length === 10 || d.length === 11) d = "55" + d;
  const e164 = "+" + d;
  return /^\+[1-9][0-9]{7,14}$/.test(e164) ? e164 : null;
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

  let body: {
    nome?: string;
    email?: string;
    password?: string;
    role?: string;
    department_id?: string | null;
    whatsapp?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "JSON inválido" });
  }
  const nome = body.nome?.trim();
  const email = body.email?.trim().toLowerCase();
  const password = body.password;
  // WhatsApp pessoal (opcional). Se veio preenchido, precisa ser E.164 válido.
  const whatsappRaw = body.whatsapp?.trim();
  const whatsapp = whatsappRaw ? normalizarE164(whatsappRaw) : null;
  if (whatsappRaw && !whatsapp) {
    return json(400, { error: "WhatsApp inválido. Use DDD + número (ex.: 11 91234-5678)." });
  }
  // Compat: sem role explícito, mantém o comportamento antigo (colaborador).
  const role = (body.role ?? "colaborador").trim();
  const isAdmin = role === "administrador";
  const department_id = isAdmin ? null : body.department_id;

  if (role !== "administrador" && role !== "colaborador") {
    return json(400, { error: "Papel inválido (use 'administrador' ou 'colaborador')" });
  }
  if (!nome || !email || !password) {
    return json(400, { error: "Campos obrigatórios: nome, email, password" });
  }
  if (!isAdmin && !department_id) {
    return json(400, { error: "Colaborador exige um departamento" });
  }
  if (password.length < 8) return json(400, { error: "Senha deve ter pelo menos 8 caracteres" });

  // Empresa do chamador (single-tenant: há uma só). Usada para o company_members.
  const { data: callerMember } = await admin
    .from("company_members")
    .select("company_id")
    .eq("user_id", callerId)
    .eq("ativo", true)
    .maybeSingle();
  let companyId = callerMember?.company_id as string | undefined;
  if (!companyId) {
    const { data: anyCompany } = await admin
      .from("companies")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    companyId = anyCompany?.id as string | undefined;
  }

  // Cria no Auth (com marcador de senha temporária)
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { must_change_password: true },
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
    whatsapp,
    ativo: true,
    disponivel: true,
    is_superadmin: isAdmin,
    is_system_user: false,
  });

  if (insertErr) {
    await admin.auth.admin.deleteUser(newId); // rollback Auth
    return json(400, { error: `Falha ao criar registro: ${insertErr.message}` });
  }

  // Vínculo com a empresa (papel canônico). Não bloqueia o cadastro se falhar:
  // com a trava multi-empresa desligada, o company_members não afeta a operação.
  if (companyId) {
    const { error: memberErr } = await admin.from("company_members").insert({
      company_id: companyId,
      user_id: newId,
      role: isAdmin ? "administrador" : "colaborador",
      department_id,
      created_by: callerId,
    });
    if (memberErr) {
      console.warn("[criar-colaborador] company_members falhou:", memberErr.message);
    }
  }

  return json(200, { id: newId, nome, email, role });
});
