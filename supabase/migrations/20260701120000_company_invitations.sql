-- ============================================================================
-- MULTI-TENANCY: CONVITES / PESSOAS PENDENTES (Pedido 2)
-- Registro de "pessoa que pertence a um espaço mas ainda não tem login".
-- Guarda:
--   - o DONO que a Almore define ao criar o espaço (cantinho temporário), e
--   - os CONVITES feitos na tela de membros (admin/colaborador).
-- Quando o login existir (fase futura), cada linha vira um company_members
-- ativo de verdade. Nada aqui vira public.users agora, de propósito: pessoa
-- pendente NÃO deve aparecer nas telas de colaboradores/roteamento.
--
-- Segue a MESMA ponte da Fase 1: políticas na forma final, gated pelos helpers
-- que curto-circuitam para permissivo enquanto a flag auth_enforcement_enabled
-- for 'false'. Em modo aberto (hoje) tudo funciona; com a flag ligada, as
-- mesmas regras duras de "quem mexe em quem" passam a valer.
--
-- DADOS EXISTENTES: nada é migrado nem apagado. Só nasce a tabela nova.
-- ============================================================================

CREATE TABLE public.company_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  email extensions.citext NOT NULL,
  nome text NOT NULL,
  role public.company_role NOT NULL,
  department_id uuid,            -- obrigatório para colaborador; nulo para dono/admin
  status text NOT NULL DEFAULT 'pendente',  -- 'pendente' hoje; 'aceito'/'cancelado' no futuro
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- um convite por e-mail por empresa
  CONSTRAINT company_invitations_unique UNIQUE (company_id, email),
  -- colaborador já entra ligado a um departamento
  CONSTRAINT company_invitations_colaborador_dept_chk
    CHECK (role <> 'colaborador' OR department_id IS NOT NULL),
  -- o departamento precisa ser da MESMA empresa
  CONSTRAINT company_invitations_dept_same_company_fk
    FOREIGN KEY (department_id, company_id) REFERENCES public.departments(id, company_id)
);

-- um único dono pendente por empresa (espelha one_owner_per_company de company_members)
CREATE UNIQUE INDEX one_pending_owner_per_company
  ON public.company_invitations(company_id) WHERE role = 'dono';
CREATE INDEX idx_company_invitations_company ON public.company_invitations(company_id);

CREATE TRIGGER trg_company_invitations_updated_at
  BEFORE UPDATE ON public.company_invitations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.company_invitations ENABLE ROW LEVEL SECURITY;

-- Regras duras (mesma hierarquia de company_members):
--   dono pode convidar/mexer em admin e colaborador;
--   admin só em colaborador; colaborador não gerencia ninguém.
-- Em modo aberto os helpers liberam tudo (comportamento de hoje preservado).
CREATE POLICY company_invitations_select ON public.company_invitations
  FOR SELECT TO public USING (public.is_member_of(company_id));
CREATE POLICY company_invitations_insert ON public.company_invitations
  FOR INSERT TO public
  WITH CHECK (
    public.is_member_of(company_id) AND (
      public.is_owner_of(company_id)
      OR (public.can_manage_config_in(company_id) AND role = 'colaborador')
    )
  );
CREATE POLICY company_invitations_update ON public.company_invitations
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
CREATE POLICY company_invitations_delete ON public.company_invitations
  FOR DELETE TO public
  USING (
    public.is_member_of(company_id) AND (
      public.is_owner_of(company_id)
      OR (public.can_manage_config_in(company_id) AND role = 'colaborador')
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_invitations TO anon, authenticated;
