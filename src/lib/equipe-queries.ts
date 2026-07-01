import { supabase } from "@/integrations/supabase/client";

export type PapelEquipe = "dono" | "administrador" | "colaborador";

export interface MembroEquipe {
  id: string;
  nome: string;
  email: string | null;
  ativo: boolean;
  isSuperadmin: boolean;
  departmentId: string | null;
  departmentNome: string | null;
  role: PapelEquipe | null;
}

export interface DepartamentoOpcao {
  id: string;
  nome: string;
}

/** Pessoas reais (exclui usuários de sistema/bot) + o papel na empresa. */
export async function listEquipe(): Promise<MembroEquipe[]> {
  // Duas consultas simples e merge em JS: o embed reverso de company_members
  // não está nos tipos gerados e quebraria a inferência da linha inteira.
  const [usersRes, membersRes] = await Promise.all([
    supabase
      .from("users")
      .select(
        "id, nome, email, ativo, is_superadmin, department_id, departments:department_id(nome)",
      )
      .eq("is_system_user", false)
      .order("created_at", { ascending: true }),
    supabase.from("company_members").select("user_id, role").eq("ativo", true),
  ]);
  if (usersRes.error) throw usersRes.error;
  if (membersRes.error) throw membersRes.error;

  const roleByUser = new Map<string, PapelEquipe>();
  for (const m of membersRes.data ?? []) {
    roleByUser.set(m.user_id as string, m.role as PapelEquipe);
  }

  return (usersRes.data ?? []).map((u) => {
    const dept = u.departments as unknown as { nome: string } | null;
    return {
      id: u.id as string,
      nome: u.nome as string,
      email: (u.email as string | null) ?? null,
      ativo: !!u.ativo,
      isSuperadmin: !!u.is_superadmin,
      departmentId: (u.department_id as string | null) ?? null,
      departmentNome: dept?.nome ?? null,
      role: roleByUser.get(u.id as string) ?? null,
    };
  });
}

export async function listDepartamentos(): Promise<DepartamentoOpcao[]> {
  const { data, error } = await supabase
    .from("departments")
    .select("id, nome")
    .eq("ativo", true)
    .order("nome");
  if (error) throw error;
  return (data ?? []).map((d) => ({ id: d.id as string, nome: d.nome as string }));
}

export async function criarMembro(input: {
  nome: string;
  email: string;
  password: string;
  role: "administrador" | "colaborador";
  department_id: string | null;
}) {
  const { data, error } = await supabase.functions.invoke("criar-colaborador", {
    body: input,
  });
  if (error) {
    // A edge function devolve o motivo no corpo mesmo em erro HTTP.
    const ctx = (error as { context?: { body?: unknown } }).context;
    throw new Error(
      (typeof ctx?.body === "string" && ctx.body) || error.message || "Falha ao criar",
    );
  }
  if (data?.error) throw new Error(data.error);
  return data as { id: string; nome: string; email: string; role: string };
}
