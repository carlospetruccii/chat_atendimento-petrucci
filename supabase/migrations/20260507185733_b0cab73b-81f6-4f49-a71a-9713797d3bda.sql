
-- =====================================================
-- 1) esta_em_horario_comercial
-- =====================================================
CREATE OR REPLACE FUNCTION public.esta_em_horario_comercial(ts timestamptz)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local timestamp;
  v_data date;
  v_hora time;
  v_dow smallint;
  v_holiday public.holidays%ROWTYPE;
BEGIN
  v_local := (ts AT TIME ZONE 'America/Sao_Paulo');
  v_data := v_local::date;
  v_hora := v_local::time;
  v_dow := EXTRACT(DOW FROM v_local)::smallint;

  SELECT * INTO v_holiday FROM public.holidays WHERE data = v_data;
  IF FOUND THEN
    IF v_holiday.inicio_override IS NULL OR v_holiday.fim_override IS NULL THEN
      RETURN FALSE;
    END IF;
    RETURN v_hora >= v_holiday.inicio_override AND v_hora < v_holiday.fim_override;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.business_hours
    WHERE dia_semana = v_dow
      AND v_hora >= inicio
      AND v_hora < fim
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.esta_em_horario_comercial(timestamptz) FROM PUBLIC, anon;

-- =====================================================
-- 2) proximo_horario_abertura
-- =====================================================
CREATE OR REPLACE FUNCTION public.proximo_horario_abertura(ts timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cursor timestamptz := ts;
  v_max timestamptz := ts + interval '14 days';
BEGIN
  -- Busca em incrementos de 15 minutos (suficiente para granularidade de business_hours em minutos)
  WHILE v_cursor <= v_max LOOP
    IF public.esta_em_horario_comercial(v_cursor) THEN
      RETURN v_cursor;
    END IF;
    v_cursor := v_cursor + interval '15 minutes';
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.proximo_horario_abertura(timestamptz) FROM PUBLIC, anon;

-- =====================================================
-- 3) ultimo_atendente_no_departamento
-- =====================================================
CREATE OR REPLACE FUNCTION public.ultimo_atendente_no_departamento(p_client_id uuid, p_department_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.assigned_to
  FROM public.atendimentos a
  JOIN public.users u ON u.id = a.assigned_to
  WHERE a.client_id = p_client_id
    AND a.current_department_id = p_department_id
    AND a.status = 'encerrado'
    AND a.assigned_to IS NOT NULL
    AND u.ativo = true
    AND u.disponivel = true
  ORDER BY a.closed_at DESC NULLS LAST
  LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION public.ultimo_atendente_no_departamento(uuid, uuid) FROM PUBLIC, anon;

-- =====================================================
-- 4) dentro_da_janela_continuidade
-- =====================================================
CREATE OR REPLACE FUNCTION public.dentro_da_janela_continuidade(p_client_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_today date;
  v_assigned uuid;
BEGIN
  IF NOT public.esta_em_horario_comercial(v_now) THEN
    RETURN NULL;
  END IF;

  v_today := (v_now AT TIME ZONE 'America/Sao_Paulo')::date;

  SELECT a.assigned_to INTO v_assigned
  FROM public.atendimentos a
  JOIN public.users u ON u.id = a.assigned_to
  WHERE a.client_id = p_client_id
    AND a.status = 'encerrado'
    AND a.assigned_to IS NOT NULL
    AND u.ativo = true
    AND u.disponivel = true
    AND ((a.closed_at AT TIME ZONE 'America/Sao_Paulo')::date = v_today)
  ORDER BY a.closed_at DESC
  LIMIT 1;

  RETURN v_assigned;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.dentro_da_janela_continuidade(uuid) FROM PUBLIC, anon;

-- =====================================================
-- TRIGGER 1: promove atendimento a em_atendimento na primeira outbound do atendente
-- =====================================================
CREATE OR REPLACE FUNCTION public.promote_atendimento_em_atendimento()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.direction = 'outbound' AND NEW.sender_type = 'atendente' THEN
    UPDATE public.atendimentos
       SET status = 'em_atendimento',
           first_response_at = COALESCE(first_response_at, NEW.created_at)
     WHERE id = NEW.atendimento_id
       AND status IN ('reservado','pendente');
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.promote_atendimento_em_atendimento() FROM PUBLIC, anon;

CREATE TRIGGER trg_atendimentos_promote_to_em_atendimento
  AFTER INSERT ON public.mensagens
  FOR EACH ROW EXECUTE FUNCTION public.promote_atendimento_em_atendimento();

-- =====================================================
-- TRIGGER 2: libera atendimentos quando colaborador é desligado
-- =====================================================
CREATE OR REPLACE FUNCTION public.release_atendimentos_on_user_inactive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  IF OLD.ativo = true AND NEW.ativo = false THEN
    FOR r IN
      SELECT id FROM public.atendimentos
       WHERE assigned_to = OLD.id
         AND status IN ('reservado','em_atendimento')
    LOOP
      UPDATE public.atendimentos
         SET assigned_to = NULL,
             status = 'pendente',
             assigned_at = NULL
       WHERE id = r.id;

      INSERT INTO public.timeline_events
        (atendimento_id, tipo_evento, actor_user_id, target_user_id, payload)
      VALUES
        (r.id, 'escalado', NULL, OLD.id, jsonb_build_object('motivo','colaborador_desligado'));
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.release_atendimentos_on_user_inactive() FROM PUBLIC, anon;

CREATE TRIGGER trg_users_release_on_inactive
  AFTER UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.release_atendimentos_on_user_inactive();

-- =====================================================
-- TRIGGER 3: carimba mensagens da triagem ao sair de em_triagem
-- =====================================================
CREATE OR REPLACE FUNCTION public.carimba_mensagens_triagem()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'em_triagem'
     AND NEW.status IS DISTINCT FROM 'em_triagem'
     AND NEW.current_department_id IS NOT NULL THEN

    UPDATE public.mensagens
       SET department_id = NEW.current_department_id
     WHERE atendimento_id = NEW.id
       AND department_id IS NULL;

    IF NEW.triagem_finished_at IS NULL THEN
      NEW.triagem_finished_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.carimba_mensagens_triagem() FROM PUBLIC, anon;

CREATE TRIGGER trg_atendimentos_carimba_mensagens_triagem
  BEFORE UPDATE ON public.atendimentos
  FOR EACH ROW EXECUTE FUNCTION public.carimba_mensagens_triagem();
