-- Agenda de contatos do Google (Google People API) — feature ADITIVA.
--
-- Objetivo:
--   1. Guardar a conexão com a conta Google (tokens) — tabela google_integration.
--   2. Guardar os contatos sincronizados da agenda — tabela agenda_contatos.
--
-- Decisões de segurança (respeitam o modo aberto / single-tenant):
--   - NÃO acorda multi-empresa: company_id entra apenas com o DEFAULT
--     'Empresa Exemplo' (como todas as outras tabelas) e as policies usam o
--     mesmo porteiro is_member_of() que hoje libera tudo (auth_enforcement off).
--   - google_integration guarda TOKENS: RLS ligada e SEM policy para o papel
--     autenticado → só o service_role (Edge Functions) enxerga. O frontend
--     nunca lê tokens direto; vê o status pela função google-contacts.
--   - agenda_contatos: leitura liberada para autenticados (como clients), mas
--     escrita só pelo backend (service_role) — o sync roda nas Edge Functions.

-- ---------------------------------------------------------------------------
-- 1) google_integration — a conexão (single row lógico). Tokens ficam aqui.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.google_integration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT '11111111-1111-1111-1111-111111111111'::uuid
    REFERENCES public.companies(id) ON DELETE CASCADE,
  connected boolean NOT NULL DEFAULT false,
  connected_email text,
  access_token text,
  refresh_token text,
  token_expiry timestamptz,
  scope text,
  -- syncToken da People API para sincronização incremental (só o delta).
  sync_token text,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  contacts_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Só pode existir uma conexão por empresa (single-tenant: uma no total).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_google_integration_company
  ON public.google_integration(company_id);

DROP TRIGGER IF EXISTS trg_google_integration_updated_at ON public.google_integration;
CREATE TRIGGER trg_google_integration_updated_at
  BEFORE UPDATE ON public.google_integration
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.google_integration ENABLE ROW LEVEL SECURITY;
-- Intencionalmente SEM policies: apenas service_role (backend) acessa.
-- O frontend consulta status via Edge Function google-contacts (action=status).

-- ---------------------------------------------------------------------------
-- 2) agenda_contatos — os contatos vindos do Google.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agenda_contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT '11111111-1111-1111-1111-111111111111'::uuid
    REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Identificador estável do contato no Google (people/cXXXX). Chave do upsert.
  google_resource_name text NOT NULL,
  nome text,
  -- Número normalizado E.164 com '+', quando o contato tiver telefone.
  -- Pode ser nulo (contato sem telefone) — ainda aparece na agenda.
  numero_whatsapp text,
  -- Número como veio do Google (para exibir/depurar quando não normalizável).
  numero_raw text,
  emails jsonb NOT NULL DEFAULT '[]'::jsonb,
  etag text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agenda_numero_e164 CHECK (
    numero_whatsapp IS NULL OR numero_whatsapp ~ '^\+[1-9][0-9]{7,14}$'
  )
);

-- Upsert por (empresa, resource_name).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_agenda_company_resource
  ON public.agenda_contatos(company_id, google_resource_name);

-- Casamento rápido número → nome (usado no Inbox).
CREATE INDEX IF NOT EXISTS idx_agenda_company_numero
  ON public.agenda_contatos(company_id, numero_whatsapp)
  WHERE numero_whatsapp IS NOT NULL;

-- Busca por nome (agenda / autocomplete).
CREATE INDEX IF NOT EXISTS idx_agenda_nome ON public.agenda_contatos(nome);

DROP TRIGGER IF EXISTS trg_agenda_contatos_updated_at ON public.agenda_contatos;
CREATE TRIGGER trg_agenda_contatos_updated_at
  BEFORE UPDATE ON public.agenda_contatos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.agenda_contatos ENABLE ROW LEVEL SECURITY;

-- Leitura: mesma regra dos clients (porteiro is_member_of, hoje libera tudo).
DROP POLICY IF EXISTS agenda_contatos_select ON public.agenda_contatos;
CREATE POLICY agenda_contatos_select ON public.agenda_contatos
  FOR SELECT TO public USING (public.is_member_of(company_id));

-- Escrita: somente backend (service_role bypassa RLS). Nenhuma policy de
-- insert/update/delete para o papel autenticado → o sync é sempre server-side.
