-- Lista "Sem Triagem" — números que NÃO recebem nenhuma triagem.
--
-- Lista SEPARADA da "Lista de Sessões" (sessoes_triagem). São coisas distintas:
--   - sessoes_triagem: número roda o fluxo interno (saudação → setor → colaborador).
--   - numeros_sem_triagem: número pula TUDO — a primeira mensagem já abre um
--     atendimento concluído, direto na fila geral de Pendentes, sem nenhuma
--     mensagem do bot.
--
-- Mesma estrutura/segurança de sessoes_triagem (ver 20260703120000):
--   - company_id com DEFAULT single-tenant.
--   - Leitura: qualquer membro da empresa (is_member_of).
--   - Escrita: só quem gerencia config (dono/administrador) — can_manage_config_in.
--   - Número em E.164 (+55...), UNIQUE por empresa (idempotente).

CREATE TABLE IF NOT EXISTS public.numeros_sem_triagem (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT '11111111-1111-1111-1111-111111111111'::uuid
    REFERENCES public.companies(id) ON DELETE CASCADE,
  numero_whatsapp text NOT NULL,
  nome text,
  ativo boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT numeros_sem_triagem_numero_e164 CHECK (
    numero_whatsapp ~ '^\+[1-9][0-9]{7,14}$'
  ),
  CONSTRAINT numeros_sem_triagem_company_numero_key UNIQUE (company_id, numero_whatsapp)
);

-- Lookup rápido do webhook: (empresa, número) filtrando ativos.
CREATE INDEX IF NOT EXISTS idx_numeros_sem_triagem_company_numero
  ON public.numeros_sem_triagem(company_id, numero_whatsapp)
  WHERE ativo = true;

DROP TRIGGER IF EXISTS trg_numeros_sem_triagem_updated_at ON public.numeros_sem_triagem;
CREATE TRIGGER trg_numeros_sem_triagem_updated_at
  BEFORE UPDATE ON public.numeros_sem_triagem
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.numeros_sem_triagem ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS numeros_sem_triagem_select ON public.numeros_sem_triagem;
CREATE POLICY numeros_sem_triagem_select ON public.numeros_sem_triagem
  FOR SELECT TO public USING (public.is_member_of(company_id));

DROP POLICY IF EXISTS numeros_sem_triagem_insert ON public.numeros_sem_triagem;
CREATE POLICY numeros_sem_triagem_insert ON public.numeros_sem_triagem
  FOR INSERT TO public
  WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));

DROP POLICY IF EXISTS numeros_sem_triagem_update ON public.numeros_sem_triagem;
CREATE POLICY numeros_sem_triagem_update ON public.numeros_sem_triagem
  FOR UPDATE TO public
  USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id))
  WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));

DROP POLICY IF EXISTS numeros_sem_triagem_delete ON public.numeros_sem_triagem;
CREATE POLICY numeros_sem_triagem_delete ON public.numeros_sem_triagem
  FOR DELETE TO public
  USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));

COMMENT ON TABLE public.numeros_sem_triagem IS
  'Lista Sem Triagem: números liberados que pulam TODA a triagem (inclusive o fluxo de sessão) e abrem atendimento direto como concluído na fila geral de Pendentes. Separada de sessoes_triagem.';
