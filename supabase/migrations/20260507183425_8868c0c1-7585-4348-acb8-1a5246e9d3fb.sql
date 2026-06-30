
-- Trigger function: atualiza updated_at em cada UPDATE
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ============================================================
-- departments
-- ============================================================
CREATE TABLE public.departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL UNIQUE,
  cor TEXT NOT NULL DEFAULT '#64748b',
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_departments_updated_at
  BEFORE UPDATE ON public.departments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- users (colaboradores; sem FK para auth.users)
-- ============================================================
CREATE TABLE public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  email extensions.citext UNIQUE,
  department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  disponivel BOOLEAN NOT NULL DEFAULT true,
  is_system_user BOOLEAN NOT NULL DEFAULT false,
  is_superadmin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- usuário fictício não tem email; usuário real precisa de email
  CONSTRAINT users_email_consistency CHECK (
    (is_system_user = true AND email IS NULL)
    OR (is_system_user = false AND email IS NOT NULL)
  )
);

CREATE INDEX idx_users_department_id ON public.users(department_id);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Trigger: is_superadmin = true é imutável (não pode voltar a false nem ser alterado)
CREATE OR REPLACE FUNCTION public.protect_superadmin_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.is_superadmin = true AND NEW.is_superadmin IS DISTINCT FROM OLD.is_superadmin THEN
    RAISE EXCEPTION 'is_superadmin é imutável após ser definido como TRUE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_protect_superadmin
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.protect_superadmin_flag();

-- ============================================================
-- user_permissions
-- ============================================================
CREATE TABLE public.user_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, permission)
);

CREATE INDEX idx_user_permissions_user_id ON public.user_permissions(user_id);
CREATE INDEX idx_user_permissions_permission ON public.user_permissions(permission);

CREATE TRIGGER trg_user_permissions_updated_at
  BEFORE UPDATE ON public.user_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- Helpers de RLS
-- ============================================================

-- Retorna o department_id do usuário logado (auth.uid()), ou NULL.
-- SECURITY DEFINER para evitar recursão de RLS na própria tabela users.
CREATE OR REPLACE FUNCTION public.current_user_department()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT department_id FROM public.users WHERE id = auth.uid()
$$;

-- Retorna TRUE se o usuário logado tem a flag informada em user_permissions.
CREATE OR REPLACE FUNCTION public.has_permission(flag TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_permissions
    WHERE user_id = auth.uid() AND permission = flag
  )
$$;

-- Retorna TRUE se o usuário é superadmin OU tem a flag view_all_departments.
CREATE OR REPLACE FUNCTION public.current_user_can_view_all()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND is_superadmin = true
  ) OR public.has_permission('view_all_departments')
$$;

-- Helper interno para checar superadmin
CREATE OR REPLACE FUNCTION public.current_user_is_superadmin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users WHERE id = auth.uid() AND is_superadmin = true
  )
$$;

-- ============================================================
-- RLS: departments
-- ============================================================
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "departments_select_authenticated"
  ON public.departments FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "departments_insert_admin"
  ON public.departments FOR INSERT
  TO authenticated
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_departments'));

CREATE POLICY "departments_update_admin"
  ON public.departments FOR UPDATE
  TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_departments'))
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_departments'));

CREATE POLICY "departments_delete_admin"
  ON public.departments FOR DELETE
  TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_departments'));

-- ============================================================
-- RLS: users
-- ============================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_select_authenticated"
  ON public.users FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "users_insert_admin"
  ON public.users FOR INSERT
  TO authenticated
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_users'));

-- UPDATE: próprio perfil OU admin; usuários fictícios apenas superadmin.
CREATE POLICY "users_update_self_or_admin"
  ON public.users FOR UPDATE
  TO authenticated
  USING (
    CASE
      WHEN is_system_user = true THEN public.current_user_is_superadmin()
      ELSE (
        id = auth.uid()
        OR public.current_user_is_superadmin()
        OR public.has_permission('manage_users')
      )
    END
  )
  WITH CHECK (
    CASE
      WHEN is_system_user = true THEN public.current_user_is_superadmin()
      ELSE (
        id = auth.uid()
        OR public.current_user_is_superadmin()
        OR public.has_permission('manage_users')
      )
    END
  );

CREATE POLICY "users_delete_admin"
  ON public.users FOR DELETE
  TO authenticated
  USING (
    CASE
      WHEN is_system_user = true THEN public.current_user_is_superadmin()
      ELSE (public.current_user_is_superadmin() OR public.has_permission('manage_users'))
    END
  );

-- ============================================================
-- RLS: user_permissions
-- ============================================================
ALTER TABLE public.user_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_permissions_select_authenticated"
  ON public.user_permissions FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "user_permissions_insert_admin"
  ON public.user_permissions FOR INSERT
  TO authenticated
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_permissions'));

CREATE POLICY "user_permissions_delete_admin"
  ON public.user_permissions FOR DELETE
  TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_permissions'));
