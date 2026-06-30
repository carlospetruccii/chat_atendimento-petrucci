
ALTER TABLE public.atendimentos DROP CONSTRAINT atendimentos_dept_required_after_triagem_chk;
ALTER TABLE public.atendimentos ADD CONSTRAINT atendimentos_dept_required_after_triagem_chk
  CHECK (
    status = 'em_triagem'
    OR current_department_id IS NOT NULL
    OR close_reason = 'migracao_inicial'
  );
