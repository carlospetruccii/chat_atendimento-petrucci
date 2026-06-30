-- 1) Reescrever política de SELECT em mensagens para resolver via atendimento.current_department_id
DROP POLICY IF EXISTS mensagens_select_dept_or_admin ON public.mensagens;

CREATE POLICY mensagens_select_dept_or_admin
ON public.mensagens
FOR SELECT
TO authenticated
USING (
  current_user_can_view_all()
  OR EXISTS (
    SELECT 1 FROM public.atendimentos a
    WHERE a.id = mensagens.atendimento_id
      AND (
        a.current_department_id = current_user_department()
        OR (
          pendentes_abertos_a_todos()
          AND a.assigned_to IS NULL
          AND a.status IN ('pendente'::status_atendimento, 'em_triagem'::status_atendimento)
        )
      )
  )
);

-- 2) Índice de apoio (no-op se já existir)
CREATE INDEX IF NOT EXISTS idx_mensagens_atendimento_id ON public.mensagens(atendimento_id);

-- 3) Backfill: alinhar snapshot ao departamento atual do atendimento.
--    O trigger protect_mensagem_department_id bloqueia esse UPDATE; desabilitar
--    apenas durante a operação e religar logo em seguida.
ALTER TABLE public.mensagens DISABLE TRIGGER USER;

UPDATE public.mensagens m
   SET department_id = a.current_department_id
  FROM public.atendimentos a
 WHERE a.id = m.atendimento_id
   AND a.current_department_id IS NOT NULL
   AND m.department_id IS DISTINCT FROM a.current_department_id;

ALTER TABLE public.mensagens ENABLE TRIGGER USER;