-- Permite encerrar um atendimento que ainda está em triagem SEM departamento.
--
-- Bug: a constraint atendimentos_dept_required_after_triagem_chk exigia
-- current_department_id preenchido para qualquer status != 'em_triagem'.
-- Ao encerrar um atendimento ainda em triagem (o bot ainda não roteou para
-- um departamento), a função encerrar_atendimento troca o status para
-- 'encerrado' mantendo current_department_id = NULL e close_reason
-- 'manual_supervisor'/'manual_atendente' -> a CHECK falhava com 23514 e o
-- PostgREST devolvia 400 Bad Request para o frontend.
--
-- Correção: 'encerrado' é um estado terminal e não faz sentido exigir
-- departamento nele. Adicionamos essa exceção. Adicionar um OR jamais
-- invalida linhas já existentes.

ALTER TABLE public.atendimentos
  DROP CONSTRAINT IF EXISTS atendimentos_dept_required_after_triagem_chk;

ALTER TABLE public.atendimentos
  ADD CONSTRAINT atendimentos_dept_required_after_triagem_chk
  CHECK (
    status = 'em_triagem'
    OR status = 'encerrado'
    OR current_department_id IS NOT NULL
    OR close_reason = 'migracao_inicial'
  );
