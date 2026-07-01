import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuthSession } from "@/hooks/useAuthSession";

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
  user: CurrentUserProfile | null;
  loading: boolean;
  error: Error | null;
  /** true quando a sessão foi criada com senha temporária e a troca ainda não aconteceu. */
  mustChangePassword: boolean;
}

/**
 * Perfil do usuário LOGADO (Supabase Auth).
 *
 * `public.users.id === auth.users.id` (a criação sempre reaproveita o id do Auth),
 * então buscamos o perfil pelo id da sessão. As permissões vêm do sistema antigo
 * (`is_superadmin` + `user_permissions`), que é o que as telas ainda checam.
 *
 * dono/administrador → `is_superadmin = true` (enxergam tudo, incl. Configurações e Equipe).
 * colaborador        → `is_superadmin = false` + departamento (só Inbox e Pendentes).
 */
async function fetchCurrentUser(userId: string): Promise<CurrentUserProfile | null> {
  const [userRes, permsRes] = await Promise.all([
    supabase
      .from("users")
      .select(
        "id, nome, email, ativo, is_system_user, is_superadmin, department_id, departments:department_id(id, nome, cor)",
      )
      .eq("id", userId)
      .maybeSingle(),
    supabase.from("user_permissions").select("permission").eq("user_id", userId),
  ]);

  if (userRes.error) throw userRes.error;
  const data = userRes.data;
  if (!data) return null;

  const dept = data.departments as { id: string; nome: string; cor: string } | null;
  const perms = (permsRes.data ?? []).map((p) => p.permission);

  return {
    id: data.id,
    nome: data.nome,
    email: data.email ?? null,
    departmentId: data.department_id,
    departmentNome: dept?.nome ?? null,
    departmentCor: dept?.cor ?? null,
    isSuperadmin: !!data.is_superadmin,
    permissions: perms,
  };
}

export function useCurrentUser(): UseCurrentUserResult {
  const { session, loading: sessionLoading } = useAuthSession();
  const userId = session?.user?.id ?? null;
  const mustChangePassword = session?.user?.user_metadata?.must_change_password === true;

  const query = useQuery({
    queryKey: ["current-user", userId],
    queryFn: () => fetchCurrentUser(userId as string),
    enabled: !!userId,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  return {
    user: query.data ?? null,
    loading: sessionLoading || (!!userId && query.isLoading),
    error: query.error instanceof Error ? query.error : null,
    mustChangePassword,
  };
}

export function useHasPermission(flag: string): boolean {
  const { user, loading } = useCurrentUser();
  if (loading || !user) return false;
  if (user.isSuperadmin) return true;
  return user.permissions.includes(flag);
}
