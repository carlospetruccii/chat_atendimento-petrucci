-- Regressão: uma transferência entre setores não pode apagar da visão do
-- colaborador o atendimento do qual ele participou.
--
-- Roda em transação e não deixa fixtures no banco.
BEGIN;

INSERT INTO public.companies (id, nome)
VALUES
  ('00000000-0000-0000-0000-00000000a001', 'TESTE histórico participante A'),
  ('00000000-0000-0000-0000-00000000a002', 'TESTE histórico participante B');

INSERT INTO public.departments (id, nome, company_id)
VALUES
  ('00000000-0000-0000-0000-00000000d001', 'TESTE DP', '00000000-0000-0000-0000-00000000a001'),
  ('00000000-0000-0000-0000-00000000d002', 'TESTE Geral', '00000000-0000-0000-0000-00000000a001'),
  ('00000000-0000-0000-0000-00000000d003', 'TESTE Outra empresa', '00000000-0000-0000-0000-00000000a002');

INSERT INTO public.users (id, nome, email, department_id)
VALUES
  ('00000000-0000-0000-0000-00000000b001', 'TESTE participante', 'historico-participante@test.invalid', '00000000-0000-0000-0000-00000000d001'),
  ('00000000-0000-0000-0000-00000000b002', 'TESTE não participante', 'historico-nao-participante@test.invalid', '00000000-0000-0000-0000-00000000d001'),
  ('00000000-0000-0000-0000-00000000b003', 'TESTE admin', 'historico-admin@test.invalid', '00000000-0000-0000-0000-00000000d002'),
  ('00000000-0000-0000-0000-00000000b004', 'TESTE outra empresa', 'historico-outra-empresa@test.invalid', '00000000-0000-0000-0000-00000000d003'),
  ('00000000-0000-0000-0000-00000000b005', 'TESTE membro inativo', 'historico-inativo@test.invalid', '00000000-0000-0000-0000-00000000d001'),
  ('00000000-0000-0000-0000-00000000b006', 'TESTE admin sem participação', 'historico-admin-sem-participacao@test.invalid', '00000000-0000-0000-0000-00000000d001'),
  ('00000000-0000-0000-0000-00000000b007', 'TESTE usuário desativado', 'historico-desativado@test.invalid', '00000000-0000-0000-0000-00000000d001');

-- Desativar na tela só mexe em users.ativo: company_members segue ativo.
UPDATE public.users SET ativo = false WHERE id = '00000000-0000-0000-0000-00000000b007';

INSERT INTO public.company_members (company_id, user_id, role, department_id, ativo)
VALUES
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000b001', 'colaborador', '00000000-0000-0000-0000-00000000d001', true),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000b002', 'colaborador', '00000000-0000-0000-0000-00000000d001', true),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000b003', 'administrador', '00000000-0000-0000-0000-00000000d002', true),
  ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-00000000b004', 'colaborador', '00000000-0000-0000-0000-00000000d003', true),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000b005', 'colaborador', '00000000-0000-0000-0000-00000000d001', false),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000b006', 'administrador', '00000000-0000-0000-0000-00000000d001', true),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000b007', 'colaborador', '00000000-0000-0000-0000-00000000d001', true);

INSERT INTO public.clients (id, numero_whatsapp, nome, company_id)
VALUES (
  '00000000-0000-0000-0000-00000000c001',
  '+559999900001',
  'TESTE cliente histórico',
  '00000000-0000-0000-0000-00000000a001'
);

INSERT INTO public.atendimentos (
  id, client_id, company_id, status, current_department_id, assigned_to,
  assigned_at, closed_at, closed_by_user_id, close_reason,
  triagem_estagio, triagem_finished_at
)
VALUES (
  '00000000-0000-0000-0000-00000000e001',
  '00000000-0000-0000-0000-00000000c001',
  '00000000-0000-0000-0000-00000000a001',
  'encerrado',
  '00000000-0000-0000-0000-00000000d002',
  '00000000-0000-0000-0000-00000000b003',
  now() - interval '1 hour',
  now(),
  '00000000-0000-0000-0000-00000000b003',
  'manual_atendente',
  'concluida',
  now() - interval '1 hour'
), (
  '00000000-0000-0000-0000-00000000e002',
  '00000000-0000-0000-0000-00000000c001',
  '00000000-0000-0000-0000-00000000a001',
  'encerrado',
  '00000000-0000-0000-0000-00000000d002',
  '00000000-0000-0000-0000-00000000b001',
  now() - interval '2 hours',
  now() - interval '1 hour',
  '00000000-0000-0000-0000-00000000b003',
  'manual_atendente',
  'concluida',
  now() - interval '2 hours'
);

INSERT INTO public.timeline_events (
  atendimento_id, company_id, tipo_evento, actor_user_id, target_user_id,
  from_department_id, to_department_id
)
VALUES (
  '00000000-0000-0000-0000-00000000e001',
  '00000000-0000-0000-0000-00000000a001',
  'repassado',
  '00000000-0000-0000-0000-00000000b003',
  '00000000-0000-0000-0000-00000000b001',
  '00000000-0000-0000-0000-00000000d002',
  '00000000-0000-0000-0000-00000000d001'
), (
  '00000000-0000-0000-0000-00000000e001',
  '00000000-0000-0000-0000-00000000a001',
  'repassado',
  '00000000-0000-0000-0000-00000000b003',
  '00000000-0000-0000-0000-00000000b004',
  '00000000-0000-0000-0000-00000000d002',
  '00000000-0000-0000-0000-00000000d001'
), (
  '00000000-0000-0000-0000-00000000e001',
  '00000000-0000-0000-0000-00000000a001',
  'repassado',
  '00000000-0000-0000-0000-00000000b003',
  '00000000-0000-0000-0000-00000000b005',
  '00000000-0000-0000-0000-00000000d002',
  '00000000-0000-0000-0000-00000000d001'
), (
  '00000000-0000-0000-0000-00000000e001',
  '00000000-0000-0000-0000-00000000a001',
  'repassado',
  '00000000-0000-0000-0000-00000000b003',
  '00000000-0000-0000-0000-00000000b007',
  '00000000-0000-0000-0000-00000000d002',
  '00000000-0000-0000-0000-00000000d001'
);

INSERT INTO public.mensagens (
  atendimento_id, client_id, department_id, company_id,
  direction, sender_type, tipo, content, status_envio
)
VALUES (
  '00000000-0000-0000-0000-00000000e001',
  '00000000-0000-0000-0000-00000000c001',
  '00000000-0000-0000-0000-00000000d002',
  '00000000-0000-0000-0000-00000000a001',
  'inbound', 'cliente', 'texto', 'TESTE mensagem histórica', 'enviado'
);

-- Mesmo com a ponte permissiva desligada, o cliente REST não pode fabricar
-- um evento para se tornar participante de uma conversa.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b002","role":"authenticated"}',
  true
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.timeline_events (
      atendimento_id, company_id, tipo_evento, actor_user_id, target_user_id
    ) VALUES (
      '00000000-0000-0000-0000-00000000e001',
      '00000000-0000-0000-0000-00000000a001',
      'repassado',
      '00000000-0000-0000-0000-00000000b002',
      '00000000-0000-0000-0000-00000000b002'
    );
    RAISE EXCEPTION 'FALHOU [timeline forjada aceita]';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;

RESET ROLE;

-- Liga a tranca somente dentro desta transação para exercitar a RLS real.
UPDATE public.platform_config
SET valor = 'true'
WHERE chave = 'auth_enforcement_enabled';

SET LOCAL ROLE authenticated;

-- Participante direto: enxerga atendimento, mensagem e timeline completos.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b001","role":"authenticated"}',
  true
);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.atendimentos WHERE id = '00000000-0000-0000-0000-00000000e001') <> 1 THEN
    RAISE EXCEPTION 'FALHOU [participante atendimento]';
  END IF;
  IF (SELECT count(*) FROM public.mensagens WHERE atendimento_id = '00000000-0000-0000-0000-00000000e001') <> 1 THEN
    RAISE EXCEPTION 'FALHOU [participante mensagem]';
  END IF;
  IF (SELECT count(*) FROM public.timeline_events WHERE atendimento_id = '00000000-0000-0000-0000-00000000e001') <> 4 THEN
    RAISE EXCEPTION 'FALHOU [participante timeline]';
  END IF;
  IF (SELECT count(*) FROM public.atendimentos WHERE id = '00000000-0000-0000-0000-00000000e002') <> 1 THEN
    RAISE EXCEPTION 'FALHOU [participante por atribuição direta]';
  END IF;
END $$;

-- Administrador ativo da empresa continua vendo tudo pelas regras existentes.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b006","role":"authenticated"}',
  true
);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.atendimentos WHERE id = '00000000-0000-0000-0000-00000000e001') <> 1 THEN
    RAISE EXCEPTION 'FALHOU [administrador atendimento]';
  END IF;
  IF (SELECT count(*) FROM public.mensagens WHERE atendimento_id = '00000000-0000-0000-0000-00000000e001') <> 1 THEN
    RAISE EXCEPTION 'FALHOU [administrador mensagem]';
  END IF;
END $$;

-- Outro setor e sem participação: não herda o histórico de terceiros.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b002","role":"authenticated"}',
  true
);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.atendimentos WHERE id = '00000000-0000-0000-0000-00000000e001') <> 0 THEN
    RAISE EXCEPTION 'FALHOU [não participante atendimento]';
  END IF;
  IF (SELECT count(*) FROM public.mensagens WHERE atendimento_id = '00000000-0000-0000-0000-00000000e001') <> 0 THEN
    RAISE EXCEPTION 'FALHOU [não participante mensagem]';
  END IF;
END $$;

-- Outra empresa e membro inativo nunca atravessam o isolamento.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b004","role":"authenticated"}',
  true
);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.atendimentos WHERE id = '00000000-0000-0000-0000-00000000e001') <> 0 THEN
    RAISE EXCEPTION 'FALHOU [outra empresa]';
  END IF;
END $$;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b005","role":"authenticated"}',
  true
);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.atendimentos WHERE id = '00000000-0000-0000-0000-00000000e001') <> 0 THEN
    RAISE EXCEPTION 'FALHOU [membro inativo]';
  END IF;
END $$;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b007","role":"authenticated"}',
  true
);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.atendimentos WHERE id = '00000000-0000-0000-0000-00000000e001') <> 0 THEN
    RAISE EXCEPTION 'FALHOU [usuário desativado]';
  END IF;
END $$;

RESET ROLE;

-- Sem sessão autenticada não há acesso ao histórico.
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.atendimentos WHERE id = '00000000-0000-0000-0000-00000000e001') <> 0 THEN
    RAISE EXCEPTION 'FALHOU [anônimo]';
  END IF;
END $$;

RESET ROLE;
ROLLBACK;
