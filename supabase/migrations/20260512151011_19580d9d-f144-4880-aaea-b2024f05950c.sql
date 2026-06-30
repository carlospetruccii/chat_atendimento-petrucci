
-- 1. Nova chave de configuração
INSERT INTO public.system_config (chave, valor, tipo, descricao)
VALUES (
  'pendentes_abertos_a_todos',
  'false',
  'booleano',
  'Modo emergência: libera leitura de pendentes entre departamentos enquanto a triagem estiver desligada'
)
ON CONFLICT (chave) DO NOTHING;

-- 2. Função: lê a flag (default false)
CREATE OR REPLACE FUNCTION public.pendentes_abertos_a_todos()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT valor = 'true' FROM public.system_config WHERE chave = 'pendentes_abertos_a_todos'),
    false
  )
$$;

-- 3. Função: claim atômico de pendente
CREATE OR REPLACE FUNCTION public.claim_pendente(p_atendimento_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_user_dept uuid;
  v_old_dept uuid;
  v_new_dept uuid;
  v_dept_changed boolean;
  v_updated_count int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  SELECT department_id INTO v_user_dept FROM public.users WHERE id = v_user_id;
  SELECT current_department_id INTO v_old_dept FROM public.atendimentos WHERE id = p_atendimento_id;

  v_new_dept := CASE
    WHEN v_old_dept IS NULL OR v_old_dept <> v_user_dept THEN v_user_dept
    ELSE v_old_dept
  END;
  v_dept_changed := (v_old_dept IS DISTINCT FROM v_new_dept);

  UPDATE public.atendimentos
     SET assigned_to = v_user_id,
         status = 'reservado',
         assigned_at = now(),
         current_department_id = v_new_dept,
         transferred_count = transferred_count + CASE WHEN v_dept_changed THEN 1 ELSE 0 END
   WHERE id = p_atendimento_id
     AND assigned_to IS NULL;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count = 0 THEN
    RETURN false;
  END IF;

  -- Carimba mensagens órfãs (não toca em mensagens já carimbadas)
  UPDATE public.mensagens
     SET department_id = v_new_dept
   WHERE atendimento_id = p_atendimento_id
     AND department_id IS NULL;

  -- Timeline
  INSERT INTO public.timeline_events
    (atendimento_id, tipo_evento, actor_user_id, target_user_id,
     from_department_id, to_department_id, payload)
  VALUES
    (p_atendimento_id, 'reservado', v_user_id, v_user_id,
     v_old_dept, v_new_dept,
     jsonb_build_object(
       'origem', 'claim_pendente',
       'dept_alterado', v_dept_changed
     ));

  RETURN true;
END;
$$;

-- 4. Policy: SELECT em atendimentos
DROP POLICY IF EXISTS atendimentos_select_dept_or_admin ON public.atendimentos;
CREATE POLICY atendimentos_select_dept_or_admin
ON public.atendimentos
FOR SELECT
TO authenticated
USING (
  current_user_can_view_all()
  OR (current_department_id = current_user_department())
  OR (
    public.pendentes_abertos_a_todos()
    AND status IN ('pendente','em_triagem')
    AND assigned_to IS NULL
  )
);

-- 5. Policy: SELECT em mensagens
DROP POLICY IF EXISTS mensagens_select_dept_or_admin ON public.mensagens;
CREATE POLICY mensagens_select_dept_or_admin
ON public.mensagens
FOR SELECT
TO authenticated
USING (
  current_user_can_view_all()
  OR (department_id = current_user_department())
  OR (
    public.pendentes_abertos_a_todos()
    AND EXISTS (
      SELECT 1 FROM public.atendimentos a
      WHERE a.id = mensagens.atendimento_id
        AND a.assigned_to IS NULL
        AND a.status IN ('pendente','em_triagem')
    )
  )
);

-- 6. Realtime para system_config (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'system_config'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.system_config';
  END IF;
END $$;

-- 7. Permissão de execução para authenticated
GRANT EXECUTE ON FUNCTION public.pendentes_abertos_a_todos() TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pendente(uuid) TO authenticated;
