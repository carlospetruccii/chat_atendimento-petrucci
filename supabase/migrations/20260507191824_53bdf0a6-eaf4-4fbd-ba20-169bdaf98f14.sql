ALTER TABLE public.atendimentos ALTER COLUMN current_department_id DROP NOT NULL;

ALTER TABLE public.atendimentos
  ADD CONSTRAINT atendimentos_dept_required_after_triagem_chk
  CHECK (status = 'em_triagem' OR current_department_id IS NOT NULL);