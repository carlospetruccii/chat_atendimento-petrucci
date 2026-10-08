-- Teste re-executável da ordem dos departamentos e do seed do bot
-- (migrations 20261006120000_departamentos_ordem e
-- 20261006120500_seed_bot_parabrisas_petrucci).
--
-- Cobre:
--   1) seed: Vendas, Suporte, Financeiro e Sem parar nessa ordem;
--   2) departamento novo sem ordem entra no fim da lista da empresa;
--   3) reordenar_departamentos grava a posição de cada id;
--   4) reordenar_departamentos recusa lista vazia, id repetido e id inexistente;
--   5) usuários de sistema Bot/Sistema e os 5 textos do bot existem;
--   6) o bot continua DESLIGADO (bot_ativo = 'false').
--
-- Roda dentro de BEGIN/ROLLBACK. Levanta EXCEPTION no primeiro caso divergente.
BEGIN;

DO $$
DECLARE
  c_company constant uuid := '11111111-1111-1111-1111-111111111111';
  v_nomes   text[];
  v_max     int;
  v_novo    uuid;
  v_ordem   int;
  v_ids     uuid[];
  v_ok      boolean;
  v_n       int;
BEGIN
  ---------------------------------------------------------------------------
  -- 1) Seed na ordem combinada.
  ---------------------------------------------------------------------------
  SELECT array_agg(nome ORDER BY ordem, nome) INTO v_nomes
    FROM public.departments
   WHERE company_id = c_company
     AND nome IN ('Vendas', 'Suporte', 'Financeiro', 'Sem parar');
  IF v_nomes IS DISTINCT FROM ARRAY['Vendas', 'Suporte', 'Financeiro', 'Sem parar'] THEN
    RAISE EXCEPTION 'CASO 1 (seed na ordem): %', v_nomes;
  END IF;

  ---------------------------------------------------------------------------
  -- 2) Novo departamento sem ordem vai para o fim.
  ---------------------------------------------------------------------------
  SELECT COALESCE(MAX(ordem), 0) INTO v_max
    FROM public.departments WHERE company_id = c_company;
  INSERT INTO public.departments (nome, company_id)
  VALUES ('__teste_ordem__', c_company)
  RETURNING id, ordem INTO v_novo, v_ordem;
  IF v_ordem <> v_max + 1 THEN
    RAISE EXCEPTION 'CASO 2 (novo no fim): esperado %, veio %', v_max + 1, v_ordem;
  END IF;

  ---------------------------------------------------------------------------
  -- 3) Reordenar grava a posição de cada id (aqui: lista invertida).
  ---------------------------------------------------------------------------
  SELECT array_agg(id ORDER BY ordem DESC, nome DESC) INTO v_ids
    FROM public.departments WHERE company_id = c_company;
  PERFORM public.reordenar_departamentos(v_ids);
  SELECT count(*) INTO v_n
    FROM unnest(v_ids) WITH ORDINALITY AS x(id, pos)
    JOIN public.departments d ON d.id = x.id
   WHERE d.ordem <> x.pos;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'CASO 3 (reordenar): % departamento(s) fora da posição', v_n;
  END IF;
  SELECT ordem INTO v_ordem FROM public.departments WHERE id = v_novo;
  IF v_ordem <> 1 THEN
    RAISE EXCEPTION 'CASO 3 (reordenar): último virou %, esperado 1', v_ordem;
  END IF;

  ---------------------------------------------------------------------------
  -- 4) Entradas inválidas são recusadas.
  ---------------------------------------------------------------------------
  v_ok := false;
  BEGIN
    PERFORM public.reordenar_departamentos(ARRAY[]::uuid[]);
  EXCEPTION WHEN invalid_parameter_value THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'CASO 4a (lista vazia aceita)'; END IF;

  v_ok := false;
  BEGIN
    PERFORM public.reordenar_departamentos(NULL);
  EXCEPTION WHEN invalid_parameter_value THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'CASO 4b (lista nula aceita)'; END IF;

  v_ok := false;
  BEGIN
    PERFORM public.reordenar_departamentos(ARRAY[v_novo, v_novo]);
  EXCEPTION WHEN invalid_parameter_value THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'CASO 4c (id repetido aceito)'; END IF;

  v_ok := false;
  BEGIN
    PERFORM public.reordenar_departamentos(ARRAY[v_novo, gen_random_uuid()]);
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'CASO 4d (id inexistente aceito)'; END IF;

  ---------------------------------------------------------------------------
  -- 5) Usuários de sistema e textos do bot.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_n FROM public.users
   WHERE id IN ('00000000-0000-0000-0000-000000000001',
                '00000000-0000-0000-0000-000000000002')
     AND is_system_user AND ativo;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'CASO 5 (usuários de sistema): % de 2', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.templates_mensagem
   WHERE company_id = c_company AND ativo
     AND chave IN ('triagem_boas_vindas', 'triagem_pergunta_departamento',
                   'triagem_confirmacao', 'triagem_erro_formato',
                   'triagem_lembrete_sem_resposta');
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'CASO 5 (textos do bot): % de 5', v_n;
  END IF;

  ---------------------------------------------------------------------------
  -- 6) O bot continua desligado.
  ---------------------------------------------------------------------------
  IF (SELECT valor FROM public.system_config WHERE chave = 'bot_ativo')
     IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'CASO 6 (bot_ativo deveria ser false)';
  END IF;

  RAISE NOTICE 'departamentos_ordem: todos os casos OK';
END;
$$;

ROLLBACK;
