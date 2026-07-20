-- =====================================================================
-- Expediente por departamento + contador de MINUTOS ÚTEIS para o alerta
-- de atendimento parado.
--
-- Objetivo: o contador de 90min do alerta deve correr SOMENTE dentro do
-- expediente do DEPARTAMENTO do atendimento (na triagem o cliente ainda não
-- tem responsável, só departamento). Almoço (vão entre faixas) pausa mas não
-- zera; fora do expediente conta 0 → se o cliente chega 18h, o contador só
-- volta a andar no próximo dia útil. Seg–sex (não há faixas de fim de semana).
-- =====================================================================

-- 1) Faixas de expediente por departamento (espelha business_hours, com escopo)
CREATE TABLE IF NOT EXISTS public.department_business_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  dia_semana smallint NOT NULL CHECK (dia_semana BETWEEN 0 AND 6), -- 0=Dom .. 6=Sáb
  inicio time NOT NULL,
  fim time NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (fim > inicio)
);

CREATE INDEX IF NOT EXISTS idx_dept_business_hours_dept_dow
  ON public.department_business_hours (department_id, dia_semana);

ALTER TABLE public.department_business_hours ENABLE ROW LEVEL SECURITY;

-- Leitura para usuários autenticados (mesma postura de business_hours: config
-- operacional visível ao time). Escrita fica a cargo de service_role/definer.
DROP POLICY IF EXISTS dept_business_hours_select ON public.department_business_hours;
CREATE POLICY dept_business_hours_select
  ON public.department_business_hours FOR SELECT
  TO authenticated
  USING (true);

-- 2) Destinatário do alerta por departamento (null → responsável padrão no código)
ALTER TABLE public.departments
  ADD COLUMN IF NOT EXISTS alert_recipient_user_id uuid REFERENCES public.users(id);

-- 3) minutos_uteis_decorridos: soma os minutos de [p_inicio, p_fim] que caem
-- dentro do expediente do departamento (respeita almoço, feriados e fim de
-- semana). Se o departamento não tem faixas próprias, usa o padrão da empresa
-- (07:30–18:00, seg–sex). Feriados são globais (tabela holidays).
CREATE OR REPLACE FUNCTION public.minutos_uteis_decorridos(
  p_inicio timestamptz,
  p_fim timestamptz,
  p_department_id uuid
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz     text := 'America/Sao_Paulo';
  v_start  timestamp := p_inicio AT TIME ZONE v_tz;
  v_end    timestamp := p_fim    AT TIME ZONE v_tz;
  v_total  integer := 0;
  v_day    date;
  v_dow    smallint;
  v_has_own boolean;
  v_holiday public.holidays%ROWTYPE;
  v_slot   record;
  v_seg_ini timestamp;
  v_seg_fim timestamp;
  -- padrão da empresa para departamentos sem faixas próprias
  c_def_ini time := TIME '07:30';
  c_def_fim time := TIME '18:00';
BEGIN
  IF p_inicio IS NULL OR p_fim IS NULL OR v_end <= v_start THEN
    RETURN 0;
  END IF;

  -- Teto de segurança: só olha os últimos 30 dias (muito mais que 90 min úteis),
  -- pro LOOP dia-a-dia não crescer sem limite em atendimentos pendentes antigos.
  v_start := GREATEST(v_start, v_end - INTERVAL '30 days');

  -- O departamento tem faixas próprias cadastradas?
  SELECT EXISTS (
    SELECT 1 FROM public.department_business_hours WHERE department_id = p_department_id
  ) INTO v_has_own;

  v_day := v_start::date;
  WHILE v_day <= v_end::date LOOP
    v_dow := EXTRACT(DOW FROM v_day)::smallint;

    -- Feriado global tem precedência sobre qualquer faixa.
    SELECT * INTO v_holiday FROM public.holidays WHERE data = v_day;
    IF FOUND THEN
      IF v_holiday.inicio_override IS NOT NULL AND v_holiday.fim_override IS NOT NULL THEN
        v_seg_ini := GREATEST(v_start, v_day + v_holiday.inicio_override);
        v_seg_fim := LEAST(v_end, v_day + v_holiday.fim_override);
        IF v_seg_fim > v_seg_ini THEN
          v_total := v_total + FLOOR(EXTRACT(EPOCH FROM (v_seg_fim - v_seg_ini)) / 60)::integer;
        END IF;
      END IF;
      -- feriado sem override = fechado → 0 no dia
      v_day := v_day + 1;
      CONTINUE;
    END IF;

    IF v_has_own THEN
      -- Faixas próprias do departamento para este dia da semana.
      FOR v_slot IN
        SELECT inicio, fim FROM public.department_business_hours
        WHERE department_id = p_department_id AND dia_semana = v_dow
      LOOP
        v_seg_ini := GREATEST(v_start, v_day + v_slot.inicio);
        v_seg_fim := LEAST(v_end, v_day + v_slot.fim);
        IF v_seg_fim > v_seg_ini THEN
          v_total := v_total + FLOOR(EXTRACT(EPOCH FROM (v_seg_fim - v_seg_ini)) / 60)::integer;
        END IF;
      END LOOP;
    ELSE
      -- Padrão da empresa: seg(1)–sex(5), 07:30–18:00.
      IF v_dow BETWEEN 1 AND 5 THEN
        v_seg_ini := GREATEST(v_start, v_day + c_def_ini);
        v_seg_fim := LEAST(v_end, v_day + c_def_fim);
        IF v_seg_fim > v_seg_ini THEN
          v_total := v_total + FLOOR(EXTRACT(EPOCH FROM (v_seg_fim - v_seg_ini)) / 60)::integer;
        END IF;
      END IF;
    END IF;

    v_day := v_day + 1;
  END LOOP;

  RETURN v_total;
END;
$$;

-- SECURITY: só service_role (Edge Functions) executa. REVOKE de PUBLIC/anon NÃO
-- basta — o Supabase concede EXECUTE explícito a `authenticated`; por isso o
-- REVOKE precisa incluir authenticated (padrão de cron_reativar_bot).
REVOKE ALL ON FUNCTION public.minutos_uteis_decorridos(timestamptz, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.minutos_uteis_decorridos(timestamptz, timestamptz, uuid) TO service_role;

-- 4) get_atendimentos_parados: candidatos (pendente/triagem) cujo tempo ÚTIL
-- decorrido já passou de p_tempo_min, com o destinatário do alerta resolvido.
CREATE OR REPLACE FUNCTION public.get_atendimentos_parados(p_tempo_min integer)
RETURNS TABLE (
  atendimento_id uuid,
  company_id uuid,
  current_department_id uuid,
  cliente_nome text,
  cliente_numero text,
  dept_nome text,
  business_min integer,
  recipient_user_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- minutos_uteis_decorridos é calculado UMA vez por linha na subquery e
  -- reaproveitado no filtro (Postgres não elimina subexpressão de função STABLE
  -- entre SELECT e WHERE). O pré-filtro por relógio remove os recentes (baratos)
  -- antes do cálculo pesado.
  SELECT t.atendimento_id, t.company_id, t.current_department_id,
         t.cliente_nome, t.cliente_numero, t.dept_nome, t.business_min, t.recipient_user_id
  FROM (
    SELECT
      a.id AS atendimento_id,
      a.company_id,
      a.current_department_id,
      c.nome AS cliente_nome,
      c.numero_whatsapp AS cliente_numero,
      d.nome AS dept_nome,
      public.minutos_uteis_decorridos(a.created_at, now(), a.current_department_id) AS business_min,
      d.alert_recipient_user_id AS recipient_user_id,
      a.created_at
    FROM public.atendimentos a
    LEFT JOIN public.clients c ON c.id = a.client_id
    LEFT JOIN public.departments d ON d.id = a.current_department_id
    WHERE a.status IN ('pendente', 'em_triagem')
      AND a.created_at <= now() - make_interval(mins => p_tempo_min)
  ) t
  WHERE t.business_min >= p_tempo_min
  ORDER BY t.created_at ASC
  LIMIT 50
$$;

-- SECURITY (CRÍTICO): esta função retorna PII (nome + numero_whatsapp de clientes).
-- REVOKE de PUBLIC/anon NÃO basta — `authenticated` tem GRANT explícito no Supabase.
-- Sem incluir authenticated, qualquer usuário logado poderia dar
-- POST /rpc/get_atendimentos_parados e baixar dados de clientes (LGPD).
REVOKE ALL ON FUNCTION public.get_atendimentos_parados(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_atendimentos_parados(integer) TO service_role;
-- TODO multi-tenant: quando ativar multi-empresa, filtrar company_id em
-- atendimentos/holidays/department_business_hours.

-- 5) Seed: faixas por departamento (seg=1 .. sex=5). Idempotente.
DO $$
DECLARE
  v_pessoal   uuid;
  v_fiscal    uuid;
  v_contabil  uuid;
  v_societario uuid;
  v_outros    uuid;
  v_larissa   uuid;
  d smallint;
BEGIN
  SELECT id INTO v_pessoal    FROM public.departments WHERE nome = 'Departamento Pessoal' LIMIT 1;
  SELECT id INTO v_fiscal     FROM public.departments WHERE nome = 'Fiscal' LIMIT 1;
  SELECT id INTO v_contabil   FROM public.departments WHERE nome = 'Contábil' LIMIT 1;
  SELECT id INTO v_societario FROM public.departments WHERE nome = 'Societário' LIMIT 1;
  SELECT id INTO v_outros     FROM public.departments WHERE nome = 'Outros' LIMIT 1;
  SELECT id INTO v_larissa    FROM public.users WHERE nome ILIKE 'Larissa%' AND is_system_user = false LIMIT 1;

  -- Só popula se ainda não houver faixas (evita duplicar em re-run).
  IF NOT EXISTS (SELECT 1 FROM public.department_business_hours) THEN
    FOR d IN 1..5 LOOP
      -- Departamento Pessoal: 08:00–12:00 e 13:00–17:30
      IF v_pessoal IS NOT NULL THEN
        INSERT INTO public.department_business_hours (department_id, dia_semana, inicio, fim)
        VALUES (v_pessoal, d, '08:00', '12:00'), (v_pessoal, d, '13:00', '17:30');
      END IF;
      -- Fiscal: 09:00–17:00
      IF v_fiscal IS NOT NULL THEN
        INSERT INTO public.department_business_hours (department_id, dia_semana, inicio, fim)
        VALUES (v_fiscal, d, '09:00', '17:00');
      END IF;
      -- Contábil / Societário / Outros: 07:30–18:00 (padrão)
      IF v_contabil IS NOT NULL THEN
        INSERT INTO public.department_business_hours (department_id, dia_semana, inicio, fim)
        VALUES (v_contabil, d, '07:30', '18:00');
      END IF;
      IF v_societario IS NOT NULL THEN
        INSERT INTO public.department_business_hours (department_id, dia_semana, inicio, fim)
        VALUES (v_societario, d, '07:30', '18:00');
      END IF;
      IF v_outros IS NOT NULL THEN
        INSERT INTO public.department_business_hours (department_id, dia_semana, inicio, fim)
        VALUES (v_outros, d, '07:30', '18:00');
      END IF;
    END LOOP;
  END IF;

  -- Destinatário: departamento "Outros" → Larissa; demais → padrão (Leticia, no código).
  IF v_outros IS NOT NULL AND v_larissa IS NOT NULL THEN
    UPDATE public.departments SET alert_recipient_user_id = v_larissa WHERE id = v_outros;
  END IF;
END $$;
