-- Teste re-executável de public.status_tempos().
-- Roda contra o banco (via MCP execute_sql, psql, ou Supabase SQL editor).
-- Tudo dentro de BEGIN/ROLLBACK: os valores mexidos aqui nunca ficam gravados.
-- Não liga bot_ativo nem nenhum cron (o bot de triagem fica desligado até
-- ordem explícita). Levanta EXCEPTION no primeiro caso que divergir; imprime
-- "TODOS OS CASOS OK" se todos passarem.
BEGIN;

DO $$
DECLARE
  v_chaves text[];
  v_motivo text;
  v_job text;
  v_bot text;
  v_estranho uuid := gen_random_uuid();
  v_admin uuid;
  v_company uuid;
BEGIN
  -- 1) Os jobs que a função consulta existem no pg_cron (nome errado = tempo
  --    "parado" para sempre, mesmo com o cron rodando).
  FOREACH v_job IN ARRAY ARRAY['triagem-bot', 'cron-alerta-atendimento-parado',
                               'cron-notificacao-admin', 'cron-encerramento-automatico'] LOOP
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job) THEN
      RAISE EXCEPTION 'FALHOU [job %]: não existe em cron.job', v_job;
    END IF;
  END LOOP;

  -- A partir daqui roda como um dono/administrador real, igual à tela.
  SELECT m.user_id, m.company_id INTO v_admin, v_company
    FROM public.company_members m
   WHERE m.ativo AND m.role IN ('dono', 'administrador')
   ORDER BY m.company_id
   LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'FALHOU [setup]: nenhum dono/administrador ativo para rodar o teste';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- 2) Devolve exatamente os 9 tempos da tela.
  SELECT array_agg(s.chave ORDER BY s.chave) INTO v_chaves FROM public.status_tempos() s;
  IF v_chaves IS DISTINCT FROM ARRAY[
    'delay_anti_flood_triagem', 'intervalo_repeticao_alerta_atendimento_parado',
    'intervalo_repeticao_notificacao_admin', 'janela_continuidade_apos_encerramento',
    'tempo_abandono_triagem', 'tempo_alerta_atendimento_parado',
    'tempo_encerramento_automatico', 'tempo_notificacao_admin', 'triagem_max_tentativas'
  ] THEN
    RAISE EXCEPTION 'FALHOU [chaves]: obtido %', v_chaves;
  END IF;

  -- 3) Janela de continuidade: 0 = desligado, qualquer outro valor = em uso.
  UPDATE public.system_config SET valor = '0' WHERE chave = 'janela_continuidade_apos_encerramento'
     AND company_id = v_company;
  SELECT s.motivo INTO v_motivo FROM public.status_tempos() s
   WHERE s.chave = 'janela_continuidade_apos_encerramento';
  IF v_motivo NOT LIKE 'Desligado:%' THEN
    RAISE EXCEPTION 'FALHOU [janela 0]: motivo %', v_motivo;
  END IF;
  UPDATE public.system_config SET valor = '72' WHERE chave = 'janela_continuidade_apos_encerramento'
     AND company_id = v_company;
  SELECT s.motivo INTO v_motivo FROM public.status_tempos() s
   WHERE s.chave = 'janela_continuidade_apos_encerramento';
  IF v_motivo IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU [janela 72]: esperado em uso, motivo %', v_motivo;
  END IF;

  -- 4) Bot desligado trava triagem, aviso ao responsável e abandono.
  SELECT valor INTO v_bot FROM public.system_config
   WHERE chave = 'bot_ativo' AND company_id = v_company;
  IF v_bot IS DISTINCT FROM 'true' THEN
    FOR v_motivo IN
      SELECT s.motivo FROM public.status_tempos() s
       WHERE s.chave IN ('delay_anti_flood_triagem', 'triagem_max_tentativas',
                         'tempo_abandono_triagem', 'tempo_alerta_atendimento_parado')
    LOOP
      IF v_motivo IS DISTINCT FROM 'Sem efeito: o bot está desligado em Operação.' THEN
        RAISE EXCEPTION 'FALHOU [bot desligado]: motivo %', v_motivo;
      END IF;
    END LOOP;
  END IF;

  -- 5) Encerramento automático desligado vence qualquer outro motivo.
  UPDATE public.system_config SET valor = 'false'
   WHERE chave = 'encerramento_automatico_ativo' AND company_id = v_company;
  SELECT s.motivo INTO v_motivo FROM public.status_tempos() s
   WHERE s.chave = 'tempo_encerramento_automatico';
  IF v_motivo NOT LIKE 'Sem efeito: o encerramento automático está desligado%' THEN
    RAISE EXCEPTION 'FALHOU [encerramento off]: motivo %', v_motivo;
  END IF;

  -- 6) Sem número do admin, os dois tempos do admin dizem isso.
  DELETE FROM public.system_config
   WHERE chave = 'numero_whatsapp_admin' AND company_id = v_company;
  FOR v_motivo IN
    SELECT s.motivo FROM public.status_tempos() s
     WHERE s.chave IN ('tempo_notificacao_admin', 'intervalo_repeticao_notificacao_admin')
  LOOP
    IF v_motivo NOT LIKE 'Sem efeito: não há número de administrador%' THEN
      RAISE EXCEPTION 'FALHOU [admin sem número]: motivo %', v_motivo;
    END IF;
  END LOOP;

  -- 7) Contagem de afetados só no aviso ao responsável, entre 0 e o teto 500.
  IF EXISTS (SELECT 1 FROM public.status_tempos() s
              WHERE (s.chave = 'tempo_alerta_atendimento_parado') = (s.afetados IS NULL)
                 OR s.afetados NOT BETWEEN 0 AND 500) THEN
    RAISE EXCEPTION 'FALHOU [afetados]: só tempo_alerta_atendimento_parado deve ter contagem (0..500)';
  END IF;

  -- 8) Quem não é membro de nenhuma empresa é barrado (mesmo com enforcement
  --    desligado: a empresa sai de company_members, não de is_member_of).
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_estranho, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.status_tempos();
    RAISE EXCEPTION 'FALHOU [não membro]: deveria ter sido barrado';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- esperado
  END;
  RESET ROLE;

  -- 9) anon não executa.
  IF has_function_privilege('anon', 'public.status_tempos()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU [anon]: anon consegue executar status_tempos()';
  END IF;
  IF has_function_privilege('authenticated', 'public.status_tempos_cron_ativo(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU [auxiliar]: authenticated consegue executar status_tempos_cron_ativo';
  END IF;

  RAISE NOTICE 'status_tempos: TODOS OS CASOS OK';
END $$;

ROLLBACK;
