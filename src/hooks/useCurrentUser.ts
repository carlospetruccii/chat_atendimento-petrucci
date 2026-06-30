import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface CurrentUserProfile {
  id: string;
  nome: string;
  email: string | null;
  departmentId: string | null;
  departmentNome: string | null;
  departmentCor: string | null;
  isSuperadmin: boolean;
  permissions: string[];
}

export interface UseCurrentUserResult {
  user: CurrentUserProfile;
  loading: boolean;
  error: Error | null;
}

const OPEN_PERMISSIONS = [
  "assign_pending",
  "force_close",
  "manage_business_hours",
  "manage_departments",
  "manage_permissions",
  "manage_routing",
  "manage_subjects",
  "manage_templates",
  "manage_times",
  "manage_users",
  "view_all_departments",
  "view_audit_log",
  "view_luana_notifications",
];

const OPEN_USER: CurrentUserProfile = {
  id: "00000000-0000-0000-0000-000000000001",
  nome: "Operador",
  email: null,
  departmentId: null,
  departmentNome: null,
  departmentCor: null,
  isSuperadmin: true,
  permissions: OPEN_PERMISSIONS,
};

async function fetchCurrentUser(): Promise<CurrentUserProfile> {
  const [userRes, permsRes] = await Promise.all([
    supabase
      .from("users")
      .select(
        "id, nome, email, ativo, is_system_user, is_superadmin, department_id, departments:department_id(id, nome, cor)",
      )
      .eq("ativo", true)
      .eq("is_system_user", false)
      .order("is_superadmin", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase.from("user_permissions").select("permission"),
  ]);

  if (userRes.error) return OPEN_USER;

  const data = userRes.data;
  if (!data || data.is_system_user || !data.ativo) return OPEN_USER;

  const dept = data.departments as { id: string; nome: string; cor: string } | null;
  const perms = permsRes.data ?? [];

  return {
    id: data.id,
    nome: data.nome,
    email: data.email ?? null,
    departmentId: data.department_id,
    departmentNome: dept?.nome ?? null,
    departmentCor: dept?.cor ?? null,
    isSuperadmin: true,
    permissions: Array.from(new Set([...OPEN_PERMISSIONS, ...perms.map((p) => p.permission)])),
  };
}

export function useCurrentUser(): UseCurrentUserResult {
  const query = useQuery({
    queryKey: ["current-user", "open-system"],
    queryFn: fetchCurrentUser,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  return {
    user: query.data ?? OPEN_USER,
    loading: false,
    error: query.error instanceof Error ? query.error : null,
  };
}

export function useHasPermission(flag: string): boolean {
  const { user, loading } = useCurrentUser();
  if (loading || !user) return false;
  if (user.isSuperadmin) return true;
  return user.permissions.includes(flag);
}
