-- Ledger do alerta de "atendimento parado" (aviso no WhatsApp pessoal do
-- responsável quando um cliente fica > tempo_alerta sem atendimento). Uma linha
-- por disparo; usado para o controle de 1ª vez / repetição na Edge Function
-- cron-alerta-atendimento-parado. Só o backend (service_role) escreve/lê.
CREATE TABLE IF NOT EXISTS public.alertas_atendimento_parado (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  atendimento_id uuid NOT NULL REFERENCES public.atendimentos(id) ON DELETE CASCADE,
  company_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alertas_atend_parado_atend_created
  ON public.alertas_atendimento_parado (atendimento_id, created_at DESC);

-- Só o backend acessa. RLS ligada sem policy (nega a anon/authenticated) e
-- GRANTs de tabela revogados por garantia. service_role bypassa ambos.
ALTER TABLE public.alertas_atendimento_parado ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.alertas_atendimento_parado FROM anon, authenticated;

COMMENT ON TABLE public.alertas_atendimento_parado IS
  'Ledger de disparos do alerta de atendimento parado (WhatsApp pessoal do responsável). Escrito só pelo backend (cron-alerta-atendimento-parado).';
