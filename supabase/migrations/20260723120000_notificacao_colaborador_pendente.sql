-- Aviso aos colaboradores quando cai um pendente: ledger + config + template.
-- O disparo em si fica na Edge Function cron-notificacao-colaboradores.

-- ── Ledger: uma linha por (atendimento, departamento). Garante "uma vez por
-- cliente por departamento" com claim atômico anti-corrida (ON CONFLICT DO
-- NOTHING). Se o cliente for repassado a outro depto, o par muda e o novo time
-- é avisado; o mesmo depto não repete. Só o backend (service_role) escreve/lê.
CREATE TABLE IF NOT EXISTS public.notificacoes_colaborador_pendente (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  atendimento_id uuid NOT NULL REFERENCES public.atendimentos(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  company_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notif_colab_pendente_uniq_atend_dept UNIQUE (atendimento_id, department_id)
);

-- RLS ligada sem policy (nega a anon/authenticated) e GRANTs revogados por
-- garantia. service_role bypassa ambos.
ALTER TABLE public.notificacoes_colaborador_pendente ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notificacoes_colaborador_pendente FROM anon, authenticated;

COMMENT ON TABLE public.notificacoes_colaborador_pendente IS
  'Ledger do aviso aos colaboradores quando cai um pendente (WhatsApp pessoal). Uma linha por (atendimento, departamento). Escrito só pelo backend (cron-notificacao-colaboradores).';

-- ── Toggle liga/desliga (aba Operação). Default off, por empresa. Idempotente.
INSERT INTO public.system_config (company_id, chave, valor, tipo, descricao)
SELECT c.id, 'notificar_colaboradores_pendente', 'false', 'booleano',
       'Quando ligado, avisa no WhatsApp pessoal os colaboradores do departamento sempre que um cliente cai como pendente.'
FROM public.companies c
ON CONFLICT (company_id, chave) DO NOTHING;

-- ── Template do aviso (a função tem um texto-fallback embutido se este sumir).
INSERT INTO public.templates_mensagem (company_id, chave, texto, variacoes, ativo)
SELECT c.id, 'notificacao_colaborador',
  E'🔔 *Novo cliente aguardando*\n\nO cliente *{{nome_cliente}}* ({{telefone}}) quer ser atendido no setor {{departamento}}.',
  ARRAY[]::text[], true
FROM public.companies c
ON CONFLICT (company_id, chave) DO NOTHING;
