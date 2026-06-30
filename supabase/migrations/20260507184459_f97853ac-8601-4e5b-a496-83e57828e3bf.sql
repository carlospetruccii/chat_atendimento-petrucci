
-- 1. clients
CREATE TABLE public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_whatsapp text NOT NULL UNIQUE,
  nome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clients_numero_whatsapp_e164 CHECK (numero_whatsapp ~ '^\+[1-9][0-9]{7,14}$')
);

CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY clients_select_authenticated ON public.clients
  FOR SELECT TO authenticated USING (true);

CREATE POLICY clients_insert_admin ON public.clients
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_users'));

CREATE POLICY clients_update_admin ON public.clients
  FOR UPDATE TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_users'))
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_users'));

CREATE POLICY clients_delete_admin ON public.clients
  FOR DELETE TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_users'));

-- 2. subjects
CREATE TABLE public.subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  cor text NOT NULL DEFAULT '#64748b',
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_subjects_department_ativo ON public.subjects(department_id, ativo);

CREATE TRIGGER trg_subjects_updated_at
  BEFORE UPDATE ON public.subjects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.subjects ENABLE ROW LEVEL SECURITY;

CREATE POLICY subjects_select_authenticated ON public.subjects
  FOR SELECT TO authenticated USING (true);

CREATE POLICY subjects_insert_admin ON public.subjects
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_subjects'));

CREATE POLICY subjects_update_admin ON public.subjects
  FOR UPDATE TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_subjects'))
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_subjects'));

CREATE POLICY subjects_delete_admin ON public.subjects
  FOR DELETE TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_subjects'));

-- 3. especialista_routing
CREATE TABLE public.especialista_routing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_especialista_routing_active_subject
  ON public.especialista_routing(subject_id) WHERE ativo = true;

CREATE TRIGGER trg_especialista_routing_updated_at
  BEFORE UPDATE ON public.especialista_routing
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.especialista_routing ENABLE ROW LEVEL SECURITY;

CREATE POLICY especialista_routing_select_authenticated ON public.especialista_routing
  FOR SELECT TO authenticated USING (true);

CREATE POLICY especialista_routing_insert_admin ON public.especialista_routing
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_routing'));

CREATE POLICY especialista_routing_update_admin ON public.especialista_routing
  FOR UPDATE TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_routing'))
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_routing'));

CREATE POLICY especialista_routing_delete_admin ON public.especialista_routing
  FOR DELETE TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_routing'));

-- 4. atendimentos
CREATE TABLE public.atendimentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  current_department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  subject_id uuid REFERENCES public.subjects(id) ON DELETE RESTRICT,
  assigned_to uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status public.status_atendimento NOT NULL DEFAULT 'em_triagem',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  first_response_at timestamptz,
  closed_at timestamptz,
  closed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  close_reason public.close_reason,
  assigned_at timestamptz,
  triagem_started_at timestamptz,
  triagem_finished_at timestamptz,
  escalated_from_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  escalated_from_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  transferred_count integer NOT NULL DEFAULT 0,
  last_message_at timestamptz
);

CREATE INDEX idx_atendimentos_status_dept ON public.atendimentos(status, current_department_id);
CREATE INDEX idx_atendimentos_assigned_status ON public.atendimentos(assigned_to, status);
CREATE INDEX idx_atendimentos_client_closed ON public.atendimentos(client_id, closed_at DESC);
CREATE INDEX idx_atendimentos_last_message_at ON public.atendimentos(last_message_at);

CREATE TRIGGER trg_atendimentos_updated_at
  BEFORE UPDATE ON public.atendimentos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.atendimentos ENABLE ROW LEVEL SECURITY;

CREATE POLICY atendimentos_select_dept_or_admin ON public.atendimentos
  FOR SELECT TO authenticated
  USING (
    public.current_user_can_view_all()
    OR current_department_id = public.current_user_department()
  );

CREATE POLICY atendimentos_insert_admin ON public.atendimentos
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_superadmin());

CREATE POLICY atendimentos_update_owner_or_admin ON public.atendimentos
  FOR UPDATE TO authenticated
  USING (
    assigned_to = auth.uid()
    OR public.current_user_is_superadmin()
    OR public.has_permission('force_close')
    OR public.has_permission('assign_pending')
  )
  WITH CHECK (
    assigned_to = auth.uid()
    OR public.current_user_is_superadmin()
    OR public.has_permission('force_close')
    OR public.has_permission('assign_pending')
  );

CREATE POLICY atendimentos_delete_superadmin ON public.atendimentos
  FOR DELETE TO authenticated
  USING (public.current_user_is_superadmin());
