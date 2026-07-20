-- Teste re-executável de public.minutos_uteis_decorridos.
-- Roda contra o banco (via MCP execute_sql, psql, ou Supabase SQL editor).
-- Levanta EXCEPTION no primeiro caso que divergir; imprime "TODOS OS CASOS OK"
-- se todos passarem. Depende do seed de department_business_hours
-- (Depto Pessoal 08-12/13-17:30, Fiscal 09-17, Outros/padrão 07:30-18:00).
DO $$
DECLARE
  v_pessoal uuid;
  v_fiscal  uuid;
  v_outros  uuid;
  v_got     integer;
  c         record;
BEGIN
  SELECT id INTO v_pessoal FROM public.departments WHERE nome = 'Departamento Pessoal' LIMIT 1;
  SELECT id INTO v_fiscal  FROM public.departments WHERE nome = 'Fiscal' LIMIT 1;
  SELECT id INTO v_outros  FROM public.departments WHERE nome = 'Outros' LIMIT 1;

  FOR c IN
    SELECT * FROM (VALUES
      -- descricao, dept, inicio, fim, esperado
      ('Pessoal 11h->14h (almoço 12-13 fora)', v_pessoal, '2026-07-20 11:00-03'::timestamptz, '2026-07-20 14:00-03'::timestamptz, 120),
      ('Pessoal 17h->17h45 (fecha 17:30)',      v_pessoal, '2026-07-20 17:00-03'::timestamptz, '2026-07-20 17:45-03'::timestamptz, 30),
      ('Pessoal 18h seg -> 08h15 ter',          v_pessoal, '2026-07-20 18:00-03'::timestamptz, '2026-07-21 08:15-03'::timestamptz, 15),
      ('Fiscal 08h->10h (abre 09h)',            v_fiscal,  '2026-07-20 08:00-03'::timestamptz, '2026-07-20 10:00-03'::timestamptz, 60),
      ('Fim de semana sab->dom (Pessoal)',      v_pessoal, '2026-07-25 09:00-03'::timestamptz, '2026-07-26 18:00-03'::timestamptz, 0),
      ('Outros (padrão 07:30-18) 07h->08h',     v_outros,  '2026-07-20 07:00-03'::timestamptz, '2026-07-20 08:00-03'::timestamptz, 30),
      ('Pessoal dia inteiro (8-12 + 13-17:30)', v_pessoal, '2026-07-20 00:00-03'::timestamptz, '2026-07-20 23:59-03'::timestamptz, 510)
    ) AS t(descricao, dept, ini, fim, esperado)
  LOOP
    v_got := public.minutos_uteis_decorridos(c.ini, c.fim, c.dept);
    IF v_got IS DISTINCT FROM c.esperado THEN
      RAISE EXCEPTION 'FALHOU [%]: esperado %, obtido %', c.descricao, c.esperado, v_got;
    END IF;
  END LOOP;

  RAISE NOTICE 'minutos_uteis_decorridos: TODOS OS CASOS OK';
END $$;
