
-- View de pendentes
CREATE OR REPLACE VIEW public.vw_pendentes
WITH (security_invoker = true)
AS
SELECT
  a.id AS atendimento_id,
  a.client_id,
  c.nome AS nome_cliente,
  c.numero_whatsapp,
  a.current_department_id,
  d.nome AS departamento_nome,
  a.subject_id,
  s.nome AS subject_nome,
  a.escalated_from_user_id,
  a.escalated_from_department_id,
  a.created_at,
  a.last_message_at,
  a.transferred_count,
  EXTRACT(EPOCH FROM (now() - COALESCE(a.last_message_at, a.created_at))) / 60.0
    AS tempo_aguardando_minutos
FROM public.atendimentos a
JOIN public.clients c ON c.id = a.client_id
LEFT JOIN public.departments d ON d.id = a.current_department_id
LEFT JOIN public.subjects s ON s.id = a.subject_id
WHERE a.status = 'pendente';

-- Helper de payload de notificação
CREATE OR REPLACE FUNCTION public.payload_notificacao_luana(p_atendimento_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_minutos integer;
  v_horas integer;
  v_resto integer;
  v_tempo text;
  v_payload jsonb;
BEGIN
  SELECT
    COALESCE(EXTRACT(EPOCH FROM (now() - COALESCE(a.last_message_at, a.created_at))) / 60, 0)::int
  INTO v_minutos
  FROM public.atendimentos a
  WHERE a.id = p_atendimento_id;

  IF v_minutos IS NULL THEN
    RETURN NULL;
  END IF;

  v_horas := v_minutos / 60;
  v_resto := v_minutos % 60;
  IF v_horas > 0 THEN
    v_tempo := v_horas || 'h ' || v_resto || 'min';
  ELSE
    v_tempo := v_resto || 'min';
  END IF;

  SELECT jsonb_build_object(
    'nome_cliente', COALESCE(c.nome, c.numero_whatsapp),
    'telefone', c.numero_whatsapp,
    'departamento', COALESCE(d.nome, '—'),
    'assunto', COALESCE(s.nome, '—'),
    'tempo_aguardando', v_tempo
  )
  INTO v_payload
  FROM public.atendimentos a
  JOIN public.clients c ON c.id = a.client_id
  LEFT JOIN public.departments d ON d.id = a.current_department_id
  LEFT JOIN public.subjects s ON s.id = a.subject_id
  WHERE a.id = p_atendimento_id;

  RETURN v_payload;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.payload_notificacao_luana(uuid) FROM PUBLIC, anon;
