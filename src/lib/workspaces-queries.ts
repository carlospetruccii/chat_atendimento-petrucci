import { supabase } from "@/integrations/supabase/client";

// Espaço de trabalho = empresa cliente (tabela companies).
export const EMPRESA_EXEMPLO_ID = "11111111-1111-1111-1111-111111111111";

export type CompanyRole = "dono" | "administrador" | "colaborador";

export const ROLE_LABEL: Record<CompanyRole, string> = {
  dono: "Dono",
  administrador: "Admin",
  colaborador: "Colaborador",
};

// ============ Espaços de trabalho (cantinho da Almore) ============

export interface WorkspaceRow {
  id: string;
  nome: string;
  ativo: boolean;
  created_at: string;
  ownerNome: string | null;
  ownerEmail: string | null;
  // true = dono ainda é um convite pendente (sem login); false = dono já é membro ativo
  ownerPendente: boolean;
}

export async function fetchWorkspaces(): Promise<WorkspaceRow[]> {
  const [companiesRes, ownersRes, invitesRes] = await Promise.all([
    supabase.from("companies").select("id, nome, ativo, created_at").order("created_at"),
    supabase
      .from("company_members")
      .select("company_id, users!company_members_user_id_fkey(nome, email)")
      .eq("role", "dono"),
    supabase.from("company_invitations").select("company_id, nome, email").eq("role", "dono"),
  ]);
  if (companiesRes.error) throw companiesRes.error;
  if (ownersRes.error) throw ownersRes.error;
  if (invitesRes.error) throw invitesRes.error;

  const activeOwners = new Map<string, { nome: string; email: string | null }>();
  for (const m of ownersRes.data ?? []) {
    const u = m.users as unknown as { nome: string; email: string | null } | null;
    if (u) activeOwners.set(m.company_id, { nome: u.nome, email: u.email });
  }
  const pendingOwners = new Map<string, { nome: string; email: string | null }>();
  for (const i of invitesRes.data ?? []) {
    pendingOwners.set(i.company_id, { nome: i.nome, email: i.email });
  }

  return (companiesRes.data ?? []).map((c) => {
    const active = activeOwners.get(c.id);
    const pending = pendingOwners.get(c.id);
    return {
      id: c.id,
      nome: c.nome,
      ativo: c.ativo,
      created_at: c.created_at,
      ownerNome: active?.nome ?? pending?.nome ?? null,
      ownerEmail: active?.email ?? pending?.email ?? null,
      ownerPendente: !active && !!pending,
    };
  });
}

export async function createWorkspace(input: {
  nome: string;
  ownerNome: string;
  ownerEmail: string;
}): Promise<string> {
  const nome = input.nome.trim();
  const ownerNome = input.ownerNome.trim();
  const ownerEmail = input.ownerEmail.trim().toLowerCase();

  const { data: company, error: cErr } = await supabase
    .from("companies")
    .insert({ nome })
    .select("id")
    .single();
  if (cErr) throw cErr;

  const { error: iErr } = await supabase.from("company_invitations").insert({
    company_id: company.id,
    email: ownerEmail,
    nome: ownerNome,
    role: "dono",
    status: "pendente",
  });
  if (iErr) {
    // Desfaz o espaço órfão (melhor esforço) para não deixar empresa sem dono.
    await supabase.from("companies").delete().eq("id", company.id);
    if (/unique|duplicate/i.test(iErr.message)) {
      throw new Error("Já existe um dono definido para este espaço.");
    }
    throw iErr;
  }
  return company.id;
}

// ============ Membros de um espaço (tela de membros) ============

export interface MemberRow {
  // id da linha (member.id ou invitation.id, conforme a origem)
  id: string;
  origem: "membro" | "convite";
  nome: string;
  email: string | null;
  role: CompanyRole;
  departmentId: string | null;
  departmentNome: string | null;
  departmentCor: string | null;
  pendente: boolean; // convite pendente (ainda sem login ativo)
}

const FALLBACK_COR = "#64748b";

export async function fetchMembers(companyId: string): Promise<MemberRow[]> {
  // department_id em company_members/company_invitations é FK composto
  // (department_id, company_id), que o PostgREST não embeda direto — então
  // buscamos os departamentos do espaço à parte e resolvemos o nome/cor em JS.
  const [membersRes, invitesRes, deptsRes] = await Promise.all([
    supabase
      .from("company_members")
      .select("id, role, department_id, ativo, users!company_members_user_id_fkey(nome, email)")
      .eq("company_id", companyId),
    supabase
      .from("company_invitations")
      .select("id, role, department_id, nome, email, status")
      .eq("company_id", companyId)
      .eq("status", "pendente"),
    supabase.from("departments").select("id, nome, cor").eq("company_id", companyId),
  ]);
  if (membersRes.error) throw membersRes.error;
  if (invitesRes.error) throw invitesRes.error;
  if (deptsRes.error) throw deptsRes.error;

  const deptMap = new Map<string, { nome: string; cor: string }>();
  for (const d of deptsRes.data ?? []) {
    deptMap.set(d.id, { nome: d.nome, cor: d.cor ?? FALLBACK_COR });
  }

  const roleRank: Record<CompanyRole, number> = { dono: 0, administrador: 1, colaborador: 2 };

  const members: MemberRow[] = (membersRes.data ?? []).map((m) => {
    const u = m.users as unknown as { nome: string; email: string | null } | null;
    const d = m.department_id ? deptMap.get(m.department_id) : null;
    return {
      id: m.id,
      origem: "membro",
      nome: u?.nome ?? "—",
      email: u?.email ?? null,
      role: m.role as CompanyRole,
      departmentId: m.department_id,
      departmentNome: d?.nome ?? null,
      departmentCor: d?.cor ?? FALLBACK_COR,
      pendente: !m.ativo,
    };
  });

  const invites: MemberRow[] = (invitesRes.data ?? []).map((i) => {
    const d = i.department_id ? deptMap.get(i.department_id) : null;
    return {
      id: i.id,
      origem: "convite",
      nome: i.nome,
      email: i.email,
      role: i.role as CompanyRole,
      departmentId: i.department_id,
      departmentNome: d?.nome ?? null,
      departmentCor: d?.cor ?? FALLBACK_COR,
      pendente: true,
    };
  });

  return [...members, ...invites].sort(
    (a, b) => roleRank[a.role] - roleRank[b.role] || a.nome.localeCompare(b.nome),
  );
}

export interface WorkspaceDepartment {
  id: string;
  nome: string;
  cor: string;
}

export async function fetchWorkspaceInfo(
  companyId: string,
): Promise<{ nome: string; departments: WorkspaceDepartment[] }> {
  const [companyRes, deptsRes] = await Promise.all([
    supabase.from("companies").select("nome").eq("id", companyId).maybeSingle(),
    supabase
      .from("departments")
      .select("id, nome, cor, ativo")
      .eq("company_id", companyId)
      .eq("ativo", true)
      .order("nome"),
  ]);
  if (companyRes.error) throw companyRes.error;
  if (deptsRes.error) throw deptsRes.error;
  return {
    nome: companyRes.data?.nome ?? "Espaço",
    departments: (deptsRes.data ?? []).map((d) => ({
      id: d.id,
      nome: d.nome,
      cor: d.cor ?? FALLBACK_COR,
    })),
  };
}

export async function inviteMember(input: {
  companyId: string;
  nome: string;
  email: string;
  role: Exclude<CompanyRole, "dono">;
  departmentId: string | null;
}) {
  if (input.role === "colaborador" && !input.departmentId) {
    throw new Error("Colaborador precisa de um departamento.");
  }
  const { error } = await supabase.from("company_invitations").insert({
    company_id: input.companyId,
    email: input.email.trim().toLowerCase(),
    nome: input.nome.trim(),
    role: input.role,
    department_id: input.role === "colaborador" ? input.departmentId : null,
    status: "pendente",
  });
  if (error) {
    if (/unique|duplicate/i.test(error.message)) {
      throw new Error("Já existe um convite para este e-mail neste espaço.");
    }
    throw error;
  }
}

export async function removeMember(row: MemberRow) {
  if (row.role === "dono") throw new Error("O dono não pode ser removido.");
  const table = row.origem === "convite" ? "company_invitations" : "company_members";
  const { error } = await supabase.from(table).delete().eq("id", row.id);
  if (error) throw error;
}

export async function changeMemberRole(
  row: MemberRow,
  newRole: CompanyRole,
  departmentId: string | null,
) {
  if (row.role === "dono" || newRole === "dono") {
    throw new Error("O papel de dono não pode ser alterado por aqui.");
  }
  if (newRole === "colaborador" && !departmentId) {
    throw new Error("Colaborador precisa de um departamento.");
  }
  const patch = {
    role: newRole,
    department_id: newRole === "colaborador" ? departmentId : null,
  };
  const table = row.origem === "convite" ? "company_invitations" : "company_members";
  const { error } = await supabase.from(table).update(patch).eq("id", row.id);
  if (error) throw error;
}
