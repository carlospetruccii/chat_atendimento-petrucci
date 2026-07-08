-- Variações de template (até 3 versões por template) + rotação anti-repetição.
--
-- Motivação: hoje cada template tem UM texto fixo. Quando o mesmo contato
-- recebe a mesma mensagem várias vezes seguidas, fica com cara de robô/spam e
-- aumenta o risco de bloqueio/denúncia do número. Agora o dono da empresa pode
-- cadastrar até 2 variações do mesmo texto; o bot alterna as versões
-- (round-robin por contato) para não repetir a mesma mensagem duas vezes
-- seguidas ao mesmo número.
--
-- Compatível com o comportamento atual: sem variações, `texto` é a única
-- versão e nada muda. O isolamento por empresa é automático — as variações
-- moram na mesma linha de `templates_mensagem`, já protegida por RLS
-- (company_id), então as versões de uma empresa nunca aparecem nem afetam
-- outra empresa.

-- =====================================================================
-- 1. Coluna de variações
-- `texto` continua sendo a VERSÃO 1. `variacoes` guarda até 2 versões extras.
-- =====================================================================
ALTER TABLE public.templates_mensagem
  ADD COLUMN IF NOT EXISTS variacoes text[] NOT NULL DEFAULT '{}'::text[];

-- No máximo 2 variações (total de 3 versões com o `texto` principal). Textos em
-- branco são filtrados no app/edge function antes de gravar.
ALTER TABLE public.templates_mensagem
  DROP CONSTRAINT IF EXISTS templates_mensagem_variacoes_chk;
ALTER TABLE public.templates_mensagem
  ADD CONSTRAINT templates_mensagem_variacoes_chk
  CHECK (array_length(variacoes, 1) IS NULL OR array_length(variacoes, 1) <= 2);

-- =====================================================================
-- 2. Rotação por contato
-- Memória de "qual versão esse contato recebeu por último", por template.
-- Chaveada pelo telefone de destino (não por client_id) para servir tanto ao
-- contato quanto a destinos sem client (ex.: notificação ao admin).
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.template_rotacao (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  destino text NOT NULL,
  chave text NOT NULL,
  ultimo_indice integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, destino, chave)
);

DROP TRIGGER IF EXISTS trg_template_rotacao_updated_at ON public.template_rotacao;
CREATE TRIGGER trg_template_rotacao_updated_at
  BEFORE UPDATE ON public.template_rotacao
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: a rotação é gravada só pelas Edge Functions (service role, que ignora
-- RLS). Usuários comuns não precisam escrever aqui; liberamos apenas leitura
-- para membros da empresa, por segurança/observabilidade.
ALTER TABLE public.template_rotacao ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS template_rotacao_select ON public.template_rotacao;
CREATE POLICY template_rotacao_select ON public.template_rotacao
  FOR SELECT TO public USING (public.is_member_of(company_id));
