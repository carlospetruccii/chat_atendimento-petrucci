-- Lista de Sessões — números liberados que PULAM a triagem.
--
-- Objetivo:
--   Uma allowlist opcional de números de WhatsApp (ou contatos já salvos) que,
--   ao mandarem a primeira mensagem, NÃO caem no bot de triagem. Em vez de
--   abrir um atendimento 'em_triagem', o webhook abre direto como 'pendente'
--   na fila geral (sem departamento), visível a todos os atendentes.
--
-- Decisões de segurança (seguem o mesmo padrão das demais tabelas de config):
--   - company_id com DEFAULT 'Empresa Exemplo' (single-tenant hoje).
--   - Leitura: qualquer membro da empresa (porteiro is_member_of).
--   - Escrita: só quem gerencia config (dono/administrador) — can_manage_config_in.
--   - Número guardado em E.164 (+55...), com UNIQUE por empresa (idempotente).

CREATE TABLE IF NOT EXISTS public.sessoes_triagem (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT '11111111-1111-1111-1111-111111111111'::uuid
    REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Número normalizado E.164 com '+'.
  numero_whatsapp text NOT NULL,
  -- Rótulo opcional (nome do contato, quando adicionado a partir dos Contatos).
  nome text,
  -- Permite desligar sem apagar (consistente com departments/templates).
  ativo boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessoes_triagem_numero_e164 CHECK (
    numero_whatsapp ~ '^\+[1-9][0-9]{7,14}$'
  ),
  CONSTRAINT sessoes_triagem_company_numero_key UNIQUE (company_id, numero_whatsapp)
);

-- Lookup rápido do webhook: (empresa, número) filtrando ativos.
CREATE INDEX IF NOT EXISTS idx_sessoes_triagem_company_numero
  ON public.sessoes_triagem(company_id, numero_whatsapp)
  WHERE ativo = true;

DROP TRIGGER IF EXISTS trg_sessoes_triagem_updated_at ON public.sessoes_triagem;
CREATE TRIGGER trg_sessoes_triagem_updated_at
  BEFORE UPDATE ON public.sessoes_triagem
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.sessoes_triagem ENABLE ROW LEVEL SECURITY;

-- Leitura: qualquer membro da empresa (hoje o porteiro libera tudo).
DROP POLICY IF EXISTS sessoes_triagem_select ON public.sessoes_triagem;
CREATE POLICY sessoes_triagem_select ON public.sessoes_triagem
  FOR SELECT TO public USING (public.is_member_of(company_id));

-- Escrita: apenas quem gerencia config (dono/administrador).
DROP POLICY IF EXISTS sessoes_triagem_insert ON public.sessoes_triagem;
CREATE POLICY sessoes_triagem_insert ON public.sessoes_triagem
  FOR INSERT TO public
  WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));

DROP POLICY IF EXISTS sessoes_triagem_update ON public.sessoes_triagem;
CREATE POLICY sessoes_triagem_update ON public.sessoes_triagem
  FOR UPDATE TO public
  USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id))
  WITH CHECK (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));

DROP POLICY IF EXISTS sessoes_triagem_delete ON public.sessoes_triagem;
CREATE POLICY sessoes_triagem_delete ON public.sessoes_triagem
  FOR DELETE TO public
  USING (public.is_member_of(company_id) AND public.can_manage_config_in(company_id));

COMMENT ON TABLE public.sessoes_triagem IS
  'Lista de Sessões: números de WhatsApp liberados que pulam a triagem e abrem atendimento direto como pendente na fila geral.';
