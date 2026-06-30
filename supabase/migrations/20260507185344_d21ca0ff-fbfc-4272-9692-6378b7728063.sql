
-- =====================================================
-- timeline_events
-- =====================================================
CREATE TABLE public.timeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  atendimento_id uuid NOT NULL REFERENCES public.atendimentos(id) ON DELETE RESTRICT,
  tipo_evento public.tipo_evento_timeline NOT NULL,
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  target_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  from_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  to_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_timeline_events_atend_created
  ON public.timeline_events(atendimento_id, created_at DESC);

ALTER TABLE public.timeline_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY timeline_events_select_dept_or_admin ON public.timeline_events
  FOR SELECT TO authenticated
  USING (
    public.current_user_can_view_all()
    OR EXISTS (
      SELECT 1 FROM public.atendimentos a
      WHERE a.id = timeline_events.atendimento_id
        AND a.current_department_id = public.current_user_department()
    )
  );

CREATE POLICY timeline_events_insert_superadmin ON public.timeline_events
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_superadmin());

CREATE OR REPLACE FUNCTION public.block_timeline_update_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'timeline_events é append-only (UPDATE/DELETE bloqueado)';
END;
$$;

CREATE TRIGGER trg_timeline_events_block_update
  BEFORE UPDATE ON public.timeline_events
  FOR EACH ROW EXECUTE FUNCTION public.block_timeline_update_delete();

CREATE TRIGGER trg_timeline_events_block_delete
  BEFORE DELETE ON public.timeline_events
  FOR EACH ROW EXECUTE FUNCTION public.block_timeline_update_delete();

-- =====================================================
-- config_audit_log
-- =====================================================
CREATE TABLE public.config_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  entidade text NOT NULL,
  entidade_id text NOT NULL,
  campo text NOT NULL,
  valor_anterior text,
  valor_novo text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_config_audit_log_entidade
  ON public.config_audit_log(entidade, entidade_id, created_at DESC);

ALTER TABLE public.config_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY config_audit_log_select_admin ON public.config_audit_log
  FOR SELECT TO authenticated
  USING (
    public.current_user_is_superadmin()
    OR public.has_permission('view_audit_log')
  );

CREATE POLICY config_audit_log_insert_superadmin ON public.config_audit_log
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_superadmin());

CREATE OR REPLACE FUNCTION public.block_audit_log_update_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'config_audit_log é append-only (UPDATE/DELETE bloqueado)';
END;
$$;

CREATE TRIGGER trg_config_audit_log_block_update
  BEFORE UPDATE ON public.config_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.block_audit_log_update_delete();

CREATE TRIGGER trg_config_audit_log_block_delete
  BEFORE DELETE ON public.config_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.block_audit_log_update_delete();

-- =====================================================
-- system_config
-- =====================================================
CREATE TABLE public.system_config (
  chave text PRIMARY KEY,
  valor text,
  tipo public.tipo_system_config NOT NULL,
  descricao text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE TRIGGER trg_system_config_updated_at
  BEFORE UPDATE ON public.system_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY system_config_select_authenticated ON public.system_config
  FOR SELECT TO authenticated USING (true);

CREATE POLICY system_config_update_admin ON public.system_config
  FOR UPDATE TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_times'))
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_times'));

CREATE POLICY system_config_insert_superadmin ON public.system_config
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_superadmin());

CREATE POLICY system_config_delete_superadmin ON public.system_config
  FOR DELETE TO authenticated
  USING (public.current_user_is_superadmin());

-- =====================================================
-- templates_mensagem
-- =====================================================
CREATE TABLE public.templates_mensagem (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chave text NOT NULL UNIQUE,
  texto text NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE TRIGGER trg_templates_mensagem_updated_at
  BEFORE UPDATE ON public.templates_mensagem
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.templates_mensagem ENABLE ROW LEVEL SECURITY;

CREATE POLICY templates_mensagem_select_authenticated ON public.templates_mensagem
  FOR SELECT TO authenticated USING (true);

CREATE POLICY templates_mensagem_insert_admin ON public.templates_mensagem
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_templates'));

CREATE POLICY templates_mensagem_update_admin ON public.templates_mensagem
  FOR UPDATE TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_templates'))
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_templates'));

CREATE POLICY templates_mensagem_delete_admin ON public.templates_mensagem
  FOR DELETE TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_templates'));

-- =====================================================
-- business_hours
-- =====================================================
CREATE TABLE public.business_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dia_semana smallint NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  inicio time NOT NULL,
  fim time NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_hours_fim_gt_inicio CHECK (fim > inicio)
);

CREATE TRIGGER trg_business_hours_updated_at
  BEFORE UPDATE ON public.business_hours
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.business_hours ENABLE ROW LEVEL SECURITY;

CREATE POLICY business_hours_select_authenticated ON public.business_hours
  FOR SELECT TO authenticated USING (true);

CREATE POLICY business_hours_insert_admin ON public.business_hours
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_business_hours'));

CREATE POLICY business_hours_update_admin ON public.business_hours
  FOR UPDATE TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_business_hours'))
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_business_hours'));

CREATE POLICY business_hours_delete_admin ON public.business_hours
  FOR DELETE TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_business_hours'));

-- =====================================================
-- holidays
-- =====================================================
CREATE TABLE public.holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data date NOT NULL UNIQUE,
  descricao text,
  inicio_override time,
  fim_override time,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT holidays_override_chk CHECK (
    (inicio_override IS NULL AND fim_override IS NULL)
    OR (inicio_override IS NOT NULL AND fim_override IS NOT NULL AND fim_override > inicio_override)
  )
);

CREATE TRIGGER trg_holidays_updated_at
  BEFORE UPDATE ON public.holidays
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.holidays ENABLE ROW LEVEL SECURITY;

CREATE POLICY holidays_select_authenticated ON public.holidays
  FOR SELECT TO authenticated USING (true);

CREATE POLICY holidays_insert_admin ON public.holidays
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_business_hours'));

CREATE POLICY holidays_update_admin ON public.holidays
  FOR UPDATE TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_business_hours'))
  WITH CHECK (public.current_user_is_superadmin() OR public.has_permission('manage_business_hours'));

CREATE POLICY holidays_delete_admin ON public.holidays
  FOR DELETE TO authenticated
  USING (public.current_user_is_superadmin() OR public.has_permission('manage_business_hours'));

-- =====================================================
-- log_config_change() — auditoria genérica
-- =====================================================
CREATE OR REPLACE FUNCTION public.log_config_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entidade_id text;
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_old_val text;
  v_new_val text;
BEGIN
  IF TG_TABLE_NAME = 'system_config' THEN
    v_entidade_id := COALESCE(NEW.chave, OLD.chave);
  ELSE
    v_entidade_id := COALESCE(NEW.id::text, OLD.id::text);
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.config_audit_log (user_id, entidade, entidade_id, campo, valor_anterior, valor_novo)
    VALUES (auth.uid(), TG_TABLE_NAME, v_entidade_id, '__row__', NULL, 'created');
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.config_audit_log (user_id, entidade, entidade_id, campo, valor_anterior, valor_novo)
    VALUES (auth.uid(), TG_TABLE_NAME, v_entidade_id, '__row__', 'deleted', NULL);
    RETURN OLD;
  END IF;

  -- UPDATE: diff por campo
  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);

  FOR v_key IN SELECT jsonb_object_keys(v_new) LOOP
    IF v_key IN ('updated_at','updated_by','created_at') THEN
      CONTINUE;
    END IF;
    v_old_val := v_old ->> v_key;
    v_new_val := v_new ->> v_key;
    IF v_old_val IS DISTINCT FROM v_new_val THEN
      INSERT INTO public.config_audit_log (user_id, entidade, entidade_id, campo, valor_anterior, valor_novo)
      VALUES (auth.uid(), TG_TABLE_NAME, v_entidade_id, v_key, v_old_val, v_new_val);
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_config_change() FROM PUBLIC, anon;

-- Anexa o trigger nas 8 tabelas de configuração
CREATE TRIGGER trg_audit_system_config
  AFTER INSERT OR UPDATE OR DELETE ON public.system_config
  FOR EACH ROW EXECUTE FUNCTION public.log_config_change();

CREATE TRIGGER trg_audit_templates_mensagem
  AFTER INSERT OR UPDATE OR DELETE ON public.templates_mensagem
  FOR EACH ROW EXECUTE FUNCTION public.log_config_change();

CREATE TRIGGER trg_audit_business_hours
  AFTER INSERT OR UPDATE OR DELETE ON public.business_hours
  FOR EACH ROW EXECUTE FUNCTION public.log_config_change();

CREATE TRIGGER trg_audit_holidays
  AFTER INSERT OR UPDATE OR DELETE ON public.holidays
  FOR EACH ROW EXECUTE FUNCTION public.log_config_change();

CREATE TRIGGER trg_audit_subjects
  AFTER INSERT OR UPDATE OR DELETE ON public.subjects
  FOR EACH ROW EXECUTE FUNCTION public.log_config_change();

CREATE TRIGGER trg_audit_departments
  AFTER INSERT OR UPDATE OR DELETE ON public.departments
  FOR EACH ROW EXECUTE FUNCTION public.log_config_change();

CREATE TRIGGER trg_audit_especialista_routing
  AFTER INSERT OR UPDATE OR DELETE ON public.especialista_routing
  FOR EACH ROW EXECUTE FUNCTION public.log_config_change();

CREATE TRIGGER trg_audit_user_permissions
  AFTER INSERT OR UPDATE OR DELETE ON public.user_permissions
  FOR EACH ROW EXECUTE FUNCTION public.log_config_change();
