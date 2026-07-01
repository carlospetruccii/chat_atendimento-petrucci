-- ============================================================================
-- MULTI-TENANCY: BASE (Pedido 1)
-- Empresas (workspaces) + papéis por empresa + a trava de isolamento por empresa
-- por cima da trava de departamento que já existe.
--
-- DESENHO DA PONTE ("escrever a regra final agora, ligar depois"):
--   Todas as políticas RLS abaixo já estão na forma FINAL — trancando empresa por
--   empresa pelo usuário logado (auth.uid()) via company_members. Mas toda a decisão
--   é delegada a funções helper que CURTO-CIRCUITAM para permissivo enquanto a flag
--   global public.platform_config('auth_enforcement_enabled') for 'false' (default).
--   Ligar a tranca = popular company_members + ligar o login + setar a flag 'true'.
--   Nenhuma política precisa ser reescrita — só "ligar".
--
--   As políticas usam TO public (anon + authenticated) de propósito: com a flag OFF
--   todos enxergam tudo (comportamento de hoje preservado); com a flag ON os helpers
--   exigem auth.uid(), então anon naturalmente fica sem nada, sem mudar a cláusula TO.
--
-- DADOS EXISTENTES: tudo é vinculado a uma "Empresa Exemplo" de id fixo
--   11111111-1111-1111-1111-111111111111. Nada é apagado.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Papéis, empresas, interruptor global
-- ----------------------------------------------------------------------------

CREATE TYPE public.company_role AS ENUM ('dono', 'administrador', 'colaborador');

CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  -- Espaço do WhatsApp da empresa: a ligação do número fica para depois,
  -- mas o lugar para guardá-la nasce agora (tudo nulável nesta fase).
  whatsapp_phone text,                       -- E.164 do número conectado (rotear inbound no futuro)
  zapi_instance_id text,
  zapi_token text,
  zapi_client_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_companies_whatsapp_phone
  ON public.companies(whatsapp_phone) WHERE whatsapp_phone IS NOT NULL;

CREATE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

-- Empresa Exemplo (recebe todos os dados que já existem)
INSERT INTO public.companies (id, nome)
VALUES ('11111111-1111-1111-1111-111111111111', 'Empresa Exemplo');

-- Interruptor global da tranca. Tabela minúscula, RLS ligado e SEM políticas:
-- ninguém lê direto; só as funções SECURITY DEFINER (que bypassam RLS) leem.
CREATE TABLE public.platform_config (
  chave text PRIMARY KEY,
  valor text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.platform_config ENABLE ROW LEVEL SECURITY;

INSERT INTO public.platform_config (chave, valor)
VALUES ('auth_enforcement_enabled', 'false');

-- ----------------------------------------------------------------------------
-- 2) company_id em tudo que já existe (+ backfill -> Empresa Exemplo)
--    ADD COLUMN ... NOT NULL DEFAULT preenche linhas existentes e mantém o
--    default = Empresa Exemplo, para que quem ainda escreve sem company_id
--    (edge functions / telas atuais) continue funcionando durante a ponte.
-- ----------------------------------------------------------------------------

DO $do$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'departments','clients','subjects','especialista_routing','atendimentos',
    'mensagens','timeline_events','templates_mensagem','business_hours','holidays',
    'notificacoes_luana','config_audit_log','cleanup_log'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN company_id uuid NOT NULL DEFAULT %L::uuid',
      t, '11111111-1111-1111-1111-111111111111'
    );
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT',
      t, t || '_company_fk'
    );
    EXECUTE format('CREATE INDEX %I ON public.%I(company_id)', 'idx_' || t || '_company', t);
  END LOOP;
END
$do$;

-- system_config: vira por-empresa (PK passa de (chave) para (company_id, chave))
ALTER TABLE public.system_config
  ADD COLUMN company_id uuid NOT NULL DEFAULT '11111111-1111-1111-1111-111111111111'::uuid;
ALTER TABLE public.system_config
  ADD CONSTRAINT system_config_company_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT;
ALTER TABLE public.system_config DROP CONSTRAINT system_config_pkey;
ALTER TABLE public.system_config ADD PRIMARY KEY (company_id, chave);

-- ----------------------------------------------------------------------------
-- 2b) Integridade cruzada: nada pode apontar para departamento/assunto/cliente/
--     atendimento de OUTRA empresa. Garantido por FKs compostas (id, company_id).
-- ----------------------------------------------------------------------------

ALTER TABLE public.departments ADD CONSTRAINT departments_id_company_key UNIQUE (id, company_id);
ALTER TABLE public.subjects     ADD CONSTRAINT subjects_id_company_key     UNIQUE (id, company_id);
ALTER TABLE public.clients      ADD CONSTRAINT clients_id_company_key      UNIQUE (id, company_id);
ALTER TABLE public.atendimentos ADD CONSTRAINT atendimentos_id_company_key UNIQUE (id, company_id);

ALTER TABLE public.subjects
  ADD CONSTRAINT subjects_dept_same_company_fk
  FOREIGN KEY (department_id, company_id) REFERENCES public.departments(id, company_id);

ALTER TABLE public.especialista_routing
  ADD CONSTRAINT esp_routing_subject_same_company_fk
  FOREIGN KEY (subject_id, company_id) REFERENCES public.subjects(id, company_id);

ALTER TABLE public.atendimentos
  ADD CONSTRAINT atendimentos_client_same_company_fk
  FOREIGN KEY (client_id, company_id) REFERENCES public.clients(id, company_id);
ALTER TABLE public.atendimentos
  ADD CONSTRAINT atendimentos_dept_same_company_fk
  FOREIGN KEY (current_department_id, company_id) REFERENCES public.departments(id, company_id);
ALTER TABLE public.atendimentos
  ADD CONSTRAINT atendimentos_subject_same_company_fk
  FOREIGN KEY (subject_id, company_id) REFERENCES public.subjects(id, company_id);

ALTER TABLE public.mensagens
  ADD CONSTRAINT mensagens_atend_same_company_fk
  FOREIGN KEY (atendimento_id, company_id) REFERENCES public.atendimentos(id, company_id);
ALTER TABLE public.mensagens
  ADD CONSTRAINT mensagens_client_same_company_fk
  FOREIGN KEY (client_id, company_id) REFERENCES public.clients(id, company_id);
ALTER TABLE public.mensagens
  ADD CONSTRAINT mensagens_dept_same_company_fk
  FOREIGN KEY (department_id, company_id) REFERENCES public.departments(id, company_id);

ALTER TABLE public.timeline_events
  ADD CONSTRAINT timeline_atend_same_company_fk
  FOREIGN KEY (atendimento_id, company_id) REFERENCES public.atendimentos(id, company_id);

-- ----------------------------------------------------------------------------
-- 2c) Unicidades passam a ser por empresa
-- ----------------------------------------------------------------------------

ALTER TABLE public.departments DROP CONSTRAINT IF EXISTS departments_nome_key;
ALTER TABLE public.departments ADD CONSTRAINT departments_company_nome_key UNIQUE (company_id, nome);

ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_numero_whatsapp_key;
ALTER TABLE public.clients ADD CONSTRAINT clients_company_numero_key UNIQUE (company_id, numero_whatsapp);

DROP INDEX IF EXISTS public.uniq_clients_chat_lid;
CREATE UNIQUE INDEX uniq_clients_company_chat_lid
  ON public.clients(company_id, chat_lid) WHERE chat_lid IS NOT NULL;

ALTER TABLE public.templates_mensagem DROP CONSTRAINT IF EXISTS templates_mensagem_chave_key;
ALTER TABLE public.templates_mensagem ADD CONSTRAINT templates_company_chave_key UNIQUE (company_id, chave);

ALTER TABLE public.holidays DROP CONSTRAINT IF EXISTS holidays_data_key;
ALTER TABLE public.holidays ADD CONSTRAINT holidays_company_data_key UNIQUE (company_id, data);

-- especialista_routing: 1 especialista ativo por assunto -> por empresa também
DROP INDEX IF EXISTS public.uniq_especialista_routing_active_subject;
CREATE UNIQUE INDEX uniq_esp_routing_active_subject
  ON public.especialista_routing(company_id, subject_id) WHERE ativo = true;

-- ----------------------------------------------------------------------------
-- 3) company_members — papel da pessoa DENTRO de cada empresa
-- ----------------------------------------------------------------------------

CREATE TABLE public.company_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role public.company_role NOT NULL,
  department_id uuid,            -- obrigatório para colaborador; nulo para dono/admin
  ativo boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- uma pessoa tem exatamente um papel por empresa
  CONSTRAINT company_members_unique UNIQUE (company_id, user_id),
  -- colaborador já entra ligado a um departamento
  CONSTRAINT company_members_colaborador_dept_chk
    CHECK (role <> 'colaborador' OR department_id IS NOT NULL),
  -- o departamento do membro precisa ser da MESMA empresa
  CONSTRAINT company_members_dept_same_company_fk
    FOREIGN KEY (department_id, company_id) REFERENCES public.departments(id, company_id)
);

-- um único dono por empresa
CREATE UNIQUE INDEX one_owner_per_company
  ON public.company_members(company_id) WHERE role = 'dono';
CREATE INDEX idx_company_members_user ON public.company_members(user_id);
CREATE INDEX idx_company_members_company ON public.company_members(company_id);

CREATE TRIGGER trg_company_members_updated_at
  BEFORE UPDATE ON public.company_members
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.company_members ENABLE ROW LEVEL SECURITY;

-- Trava do dono: ninguém remove nem rebaixa o dono (vale em qualquer modo)
CREATE OR REPLACE FUNCTION public.protect_company_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.role = 'dono' THEN
      RAISE EXCEPTION 'O dono da empresa não pode ser removido';
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.role = 'dono' AND NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'O dono não pode ser rebaixado; transfira a propriedade primeiro';
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_company_members_protect_owner
  BEFORE UPDATE OR DELETE ON public.company_members
  FOR EACH ROW EXECUTE FUNCTION public.protect_company_owner();

-- ----------------------------------------------------------------------------
-- 4) Helpers de RLS — forma final, com ponte permissiva pelo interruptor.
--    SECURITY DEFINER: bypassam RLS de company_members/companies (sem recursão).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auth_enforcement_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT valor = 'true' FROM public.platform_config WHERE chave = 'auth_enforcement_enabled'),
    false
  )
$$;

CREATE OR REPLACE FUNCTION public.is_member_of(p_company_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.auth_enforcement_enabled() THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.company_members m
    WHERE m.company_id = p_company_id AND m.user_id = auth.uid() AND m.ativo = true
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.can_view_all_in(p_company_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.auth_enforcement_enabled() THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.company_members m
    WHERE m.company_id = p_company_id AND m.user_id = auth.uid() AND m.ativo = true
      AND m.role IN ('dono','administrador')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.can_manage_config_in(p_company_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.auth_enforcement_enabled() THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.company_members m
    WHERE m.company_id = p_company_id AND m.user_id = auth.uid() AND m.ativo = true
      AND m.role IN ('dono','administrador')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_owner_of(p_company_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.auth_enforcement_enabled() THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.company_members m
    WHERE m.company_id = p_company_id AND m.user_id = auth.uid() AND m.ativo = true
      AND m.role = 'dono'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.current_department_in(p_company_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v uuid;
BEGIN
  IF NOT public.auth_enforcement_enabled() THEN
    RETURN NULL;
  END IF;
  SELECT m.department_id INTO v FROM public.company_members m
   WHERE m.company_id = p_company_id AND m.user_id = auth.uid() AND m.ativo = true;
  RETURN v;
END;
$$;

-- Versão por-empresa do modo emergência de pendentes
CREATE OR REPLACE FUNCTION public.pendentes_abertos_a_todos(p_company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT valor = 'true' FROM public.system_config
      WHERE company_id = p_company_id AND chave = 'pendentes_abertos_a_todos'),
    false
  )
$$;

-- ----------------------------------------------------------------------------
-- 5) Reescrita das políticas RLS — forma final, TO public, gated pelos helpers.
--    Removemos TODAS as políticas antigas (que usavam is_superadmin/permissões)
--    para que a tranca por empresa seja a única regra.
-- ----------------------------------------------------------------------------

-- companies
CREATE POLICY companies_select ON public.companies
  FOR SELECT TO public USING (public.is_member_of(id));
CREATE POLICY companies_insert ON public.companies
  FOR INSERT TO public
  WITH CHECK (NOT public.auth_enforcement_enabled() OR auth.uid() IS NOT NULL);
CREATE POLICY companies_update ON public.companies
  FOR UPDATE TO public
  USING (public.is_member_of(id) AND public.can_manage_config_in(id))
  WITH CHECK (public.is_member_of(id) AND public.can_manage_config_in(id));
CREATE POLICY companies_delete ON public.companies
  FOR DELETE TO public USING (public.is_member_of(id) AND public.is_owner_of(id));

-- company_members: dono gerencia admins e colaboradores; admin só colaboradores;
-- linha do dono intocável (trigger). (Em modo aberto os helpers liberam tudo.)
CREATE POLICY company_members_select ON public.company_members
  FOR SELECT TO public USING (public.is_member_of(company_id));
CREATE POLICY company_members_insert ON public.company_members
  FOR INSERT TO public
  WITH CHECK (
    public.is_member_of(company_id) AND (
      public.is_owner_of(company_id)
      OR (public.can_manage_config_in(company_id) AND role = 'colaborador')
    )
  );
CREATE POLICY company_members_update ON public.company_members
  FOR UPDATE TO public
  USING (
    public.is_member_of(company_id) AND (
      public.is_owner_of(company_id)
      OR (public.can_manage_config_in(company_id) AND role = 'colaborador')
    )
  )
  WITH CHECK (
    public.is_member_of(company_id) AND (
      public.is_owner_of(company_id)
      OR (public.can_manage_config_in(company_id) AND role = 'colaborador')
    )
  );
CREATE POLICY company_members_delete ON public.company_members
  FOR DELETE TO public
  USING (
    public.is_member_of(company_id) AND (
      public.is_owner_of(company_id)
      OR (public.can_manage_config_in(company_id) AND role = 'colaborador')
    )
  );

-- departments
DROP POLICY IF EXISTS departments_select_authenticated ON public.departments;
DROP POLICY IF EXISTS departments_insert_admin ON public.departments;
DROP POLICY IF EXISTS departments_update_admin ON public.departments;
DROP POLICY IF EXISTS departments_delete_admin ON public.departments;
CREATE POLICY departments_select ON public.departments
  FOR SELECT TO public USING (public.is_member_of(company_id));
CREATE POLICY departments_insert ON public.departments
  FOR INSERT TO public WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));
CREATE POLICY departments_update ON public.departments
  FOR UPDATE TO public
  USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id))
  WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));
CREATE POLICY departments_delete ON public.departments
  FOR DELETE TO public USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));

-- subjects
DROP POLICY IF EXISTS subjects_select_authenticated ON public.subjects;
DROP POLICY IF EXISTS subjects_insert_admin ON public.subjects;
DROP POLICY IF EXISTS subjects_update_admin ON public.subjects;
DROP POLICY IF EXISTS subjects_delete_admin ON public.subjects;
CREATE POLICY subjects_select ON public.subjects
  FOR SELECT TO public USING (public.is_member_of(company_id));
CREATE POLICY subjects_insert ON public.subjects
  FOR INSERT TO public WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));
CREATE POLICY subjects_update ON public.subjects
  FOR UPDATE TO public
  USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id))
  WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));
CREATE POLICY subjects_delete ON public.subjects
  FOR DELETE TO public USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));

-- especialista_routing
DROP POLICY IF EXISTS especialista_routing_select_authenticated ON public.especialista_routing;
DROP POLICY IF EXISTS especialista_routing_insert_admin ON public.especialista_routing;
DROP POLICY IF EXISTS especialista_routing_update_admin ON public.especialista_routing;
DROP POLICY IF EXISTS especialista_routing_delete_admin ON public.especialista_routing;
CREATE POLICY esp_routing_select ON public.especialista_routing
  FOR SELECT TO public USING (public.is_member_of(company_id));
CREATE POLICY esp_routing_insert ON public.especialista_routing
  FOR INSERT TO public WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));
CREATE POLICY esp_routing_update ON public.especialista_routing
  FOR UPDATE TO public
  USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id))
  WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));
CREATE POLICY esp_routing_delete ON public.especialista_routing
  FOR DELETE TO public USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));

-- clients
DROP POLICY IF EXISTS clients_select_authenticated ON public.clients;
DROP POLICY IF EXISTS clients_insert_admin ON public.clients;
DROP POLICY IF EXISTS clients_update_admin ON public.clients;
DROP POLICY IF EXISTS clients_update_authenticated ON public.clients;
DROP POLICY IF EXISTS clients_delete_admin ON public.clients;
CREATE POLICY clients_select ON public.clients
  FOR SELECT TO public USING (public.is_member_of(company_id));
CREATE POLICY clients_insert ON public.clients
  FOR INSERT TO public WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));
CREATE POLICY clients_update ON public.clients
  FOR UPDATE TO public USING (public.is_member_of(company_id)) WITH CHECK (public.is_member_of(company_id));
CREATE POLICY clients_delete ON public.clients
  FOR DELETE TO public USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));

-- atendimentos: CAMADA 1 (empresa) + CAMADA 2 (departamento, como hoje)
DROP POLICY IF EXISTS atendimentos_select_dept_or_admin ON public.atendimentos;
DROP POLICY IF EXISTS atendimentos_insert_admin ON public.atendimentos;
DROP POLICY IF EXISTS atendimentos_update_owner_or_admin ON public.atendimentos;
DROP POLICY IF EXISTS atendimentos_delete_superadmin ON public.atendimentos;
CREATE POLICY atendimentos_select ON public.atendimentos
  FOR SELECT TO public
  USING (
    public.is_member_of(company_id)
    AND (
      public.can_view_all_in(company_id)
      OR current_department_id = public.current_department_in(company_id)
      OR (
        public.pendentes_abertos_a_todos(company_id)
        AND status IN ('pendente','em_triagem')
        AND assigned_to IS NULL
      )
    )
  );
CREATE POLICY atendimentos_insert ON public.atendimentos
  FOR INSERT TO public
  WITH CHECK (public.is_member_of(company_id) AND public.can_view_all_in(company_id));
CREATE POLICY atendimentos_update ON public.atendimentos
  FOR UPDATE TO public
  USING (public.is_member_of(company_id) AND (assigned_to = auth.uid() OR public.can_view_all_in(company_id)))
  WITH CHECK (public.is_member_of(company_id) AND (assigned_to = auth.uid() OR public.can_view_all_in(company_id)));
CREATE POLICY atendimentos_delete ON public.atendimentos
  FOR DELETE TO public USING (public.is_member_of(company_id) AND public.can_view_all_in(company_id));

-- mensagens: herda o isolamento (empresa + departamento via department_id)
DROP POLICY IF EXISTS mensagens_select_dept_or_admin ON public.mensagens;
DROP POLICY IF EXISTS mensagens_insert_self_outbound ON public.mensagens;
DROP POLICY IF EXISTS mensagens_update_admin ON public.mensagens;
DROP POLICY IF EXISTS mensagens_delete_superadmin ON public.mensagens;
CREATE POLICY mensagens_select ON public.mensagens
  FOR SELECT TO public
  USING (
    public.is_member_of(company_id)
    AND (
      public.can_view_all_in(company_id)
      OR department_id = public.current_department_in(company_id)
      OR (
        public.pendentes_abertos_a_todos(company_id)
        AND EXISTS (
          SELECT 1 FROM public.atendimentos a
          WHERE a.id = mensagens.atendimento_id
            AND a.assigned_to IS NULL
            AND a.status IN ('pendente','em_triagem')
        )
      )
    )
  );
CREATE POLICY mensagens_insert ON public.mensagens
  FOR INSERT TO public
  WITH CHECK (
    public.is_member_of(company_id) AND (
      public.can_view_all_in(company_id)
      OR (direction = 'outbound' AND sender_type = 'atendente' AND sent_by_user_id = auth.uid())
    )
  );
CREATE POLICY mensagens_update ON public.mensagens
  FOR UPDATE TO public
  USING (public.is_member_of(company_id) AND public.can_view_all_in(company_id))
  WITH CHECK (public.is_member_of(company_id) AND public.can_view_all_in(company_id));
CREATE POLICY mensagens_delete ON public.mensagens
  FOR DELETE TO public USING (public.is_member_of(company_id) AND public.can_view_all_in(company_id));

-- timeline_events
DROP POLICY IF EXISTS timeline_events_select_dept_or_admin ON public.timeline_events;
DROP POLICY IF EXISTS timeline_events_insert_superadmin ON public.timeline_events;
CREATE POLICY timeline_events_select ON public.timeline_events
  FOR SELECT TO public
  USING (
    public.is_member_of(company_id)
    AND (
      public.can_view_all_in(company_id)
      OR EXISTS (
        SELECT 1 FROM public.atendimentos a
        WHERE a.id = timeline_events.atendimento_id
          AND a.current_department_id = public.current_department_in(company_id)
      )
    )
  );
CREATE POLICY timeline_events_insert ON public.timeline_events
  FOR INSERT TO public
  WITH CHECK (public.is_member_of(company_id) AND public.can_view_all_in(company_id));

-- system_config
DROP POLICY IF EXISTS system_config_select_authenticated ON public.system_config;
DROP POLICY IF EXISTS system_config_update_admin ON public.system_config;
DROP POLICY IF EXISTS system_config_insert_superadmin ON public.system_config;
DROP POLICY IF EXISTS system_config_delete_superadmin ON public.system_config;
CREATE POLICY system_config_select ON public.system_config
  FOR SELECT TO public USING (public.is_member_of(company_id));
CREATE POLICY system_config_insert ON public.system_config
  FOR INSERT TO public WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));
CREATE POLICY system_config_update ON public.system_config
  FOR UPDATE TO public
  USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id))
  WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));
CREATE POLICY system_config_delete ON public.system_config
  FOR DELETE TO public USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));

-- templates_mensagem
DROP POLICY IF EXISTS templates_mensagem_select_authenticated ON public.templates_mensagem;
DROP POLICY IF EXISTS templates_mensagem_insert_admin ON public.templates_mensagem;
DROP POLICY IF EXISTS templates_mensagem_update_admin ON public.templates_mensagem;
DROP POLICY IF EXISTS templates_mensagem_delete_admin ON public.templates_mensagem;
CREATE POLICY templates_select ON public.templates_mensagem
  FOR SELECT TO public USING (public.is_member_of(company_id));
CREATE POLICY templates_insert ON public.templates_mensagem
  FOR INSERT TO public WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));
CREATE POLICY templates_update ON public.templates_mensagem
  FOR UPDATE TO public
  USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id))
  WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));
CREATE POLICY templates_delete ON public.templates_mensagem
  FOR DELETE TO public USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));

-- business_hours
DROP POLICY IF EXISTS business_hours_select_authenticated ON public.business_hours;
DROP POLICY IF EXISTS business_hours_insert_admin ON public.business_hours;
DROP POLICY IF EXISTS business_hours_update_admin ON public.business_hours;
DROP POLICY IF EXISTS business_hours_delete_admin ON public.business_hours;
CREATE POLICY business_hours_select ON public.business_hours
  FOR SELECT TO public USING (public.is_member_of(company_id));
CREATE POLICY business_hours_insert ON public.business_hours
  FOR INSERT TO public WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));
CREATE POLICY business_hours_update ON public.business_hours
  FOR UPDATE TO public
  USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id))
  WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));
CREATE POLICY business_hours_delete ON public.business_hours
  FOR DELETE TO public USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));

-- holidays
DROP POLICY IF EXISTS holidays_select_authenticated ON public.holidays;
DROP POLICY IF EXISTS holidays_insert_admin ON public.holidays;
DROP POLICY IF EXISTS holidays_update_admin ON public.holidays;
DROP POLICY IF EXISTS holidays_delete_admin ON public.holidays;
CREATE POLICY holidays_select ON public.holidays
  FOR SELECT TO public USING (public.is_member_of(company_id));
CREATE POLICY holidays_insert ON public.holidays
  FOR INSERT TO public WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));
CREATE POLICY holidays_update ON public.holidays
  FOR UPDATE TO public
  USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id))
  WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));
CREATE POLICY holidays_delete ON public.holidays
  FOR DELETE TO public USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));

-- notificacoes_luana (INSERT/DELETE seguem só service_role)
DROP POLICY IF EXISTS notif_luana_select ON public.notificacoes_luana;
DROP POLICY IF EXISTS notif_luana_update ON public.notificacoes_luana;
CREATE POLICY notif_luana_select ON public.notificacoes_luana
  FOR SELECT TO public USING (public.is_member_of(company_id) AND public.can_view_all_in(company_id));
CREATE POLICY notif_luana_update ON public.notificacoes_luana
  FOR UPDATE TO public
  USING (public.is_member_of(company_id) AND public.can_view_all_in(company_id))
  WITH CHECK (public.is_member_of(company_id) AND public.can_view_all_in(company_id));

-- config_audit_log
DROP POLICY IF EXISTS config_audit_log_select_admin ON public.config_audit_log;
DROP POLICY IF EXISTS config_audit_log_insert_superadmin ON public.config_audit_log;
CREATE POLICY config_audit_log_select ON public.config_audit_log
  FOR SELECT TO public USING (public.is_member_of(company_id) AND public.can_view_all_in(company_id));
CREATE POLICY config_audit_log_insert ON public.config_audit_log
  FOR INSERT TO public WITH CHECK (public.is_member_of(company_id) AND public.can_view_all_in(company_id));

-- cleanup_log
DROP POLICY IF EXISTS cleanup_log_admin_select ON public.cleanup_log;
CREATE POLICY cleanup_log_select ON public.cleanup_log
  FOR SELECT TO public USING (public.is_member_of(company_id) AND public.can_view_all_in(company_id));

-- ----------------------------------------------------------------------------
-- 5b) GRANTs de tabela. O role do app (publishable key => anon/authenticated)
--     precisa de privilégio de tabela para que o RLS seja a regra EFETIVA
--     (o RLS só filtra linhas DEPOIS do privilégio de tabela). As tabelas novas
--     já herdaram isso por default privileges; reafirmamos as existentes aqui.
--     platform_config (o interruptor) fica FORA: ninguém além das funções
--     SECURITY DEFINER toca nele.
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.companies, public.company_members,
  public.departments, public.clients, public.subjects, public.especialista_routing,
  public.atendimentos, public.mensagens, public.timeline_events,
  public.templates_mensagem, public.business_hours, public.holidays,
  public.notificacoes_luana, public.config_audit_log, public.cleanup_log,
  public.system_config
TO anon, authenticated;

REVOKE ALL ON public.platform_config FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6) Backfill de company_members a partir dos usuários existentes (Empresa Exemplo)
--    - o primeiro usuário real vira DONO
--    - demais superadmins viram ADMINISTRADOR
--    - quem tem departamento vira COLABORADOR (ligado ao seu departamento)
--    - quem não tem departamento vira ADMINISTRADOR (colaborador exige dept)
--    Usuários de sistema (bot/sistema) NÃO entram (agem via service_role).
-- ----------------------------------------------------------------------------

WITH ranked AS (
  SELECT
    id,
    department_id,
    is_superadmin,
    row_number() OVER (ORDER BY is_superadmin DESC, created_at ASC) AS rn
  FROM public.users
  WHERE ativo = true AND is_system_user = false
)
INSERT INTO public.company_members (company_id, user_id, role, department_id)
SELECT
  '11111111-1111-1111-1111-111111111111'::uuid,
  id,
  CASE
    WHEN rn = 1 THEN 'dono'::public.company_role
    WHEN is_superadmin THEN 'administrador'::public.company_role
    WHEN department_id IS NOT NULL THEN 'colaborador'::public.company_role
    ELSE 'administrador'::public.company_role
  END,
  CASE
    WHEN rn = 1 THEN NULL
    WHEN is_superadmin THEN NULL
    WHEN department_id IS NOT NULL THEN department_id
    ELSE NULL
  END
FROM ranked;
