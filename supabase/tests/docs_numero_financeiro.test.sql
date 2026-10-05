-- Teste re-executável da aba Docs (migration 20260929200000_docs_numero_financeiro).
--
-- Cobre o ciclo da conversa (gatilho de status + RPCs), a regra "só o dono
-- escreve" no banco, o contador de não lidas e a soltura de conversas quando o
-- dono perde o acesso.
--
-- Roda dentro de BEGIN/ROLLBACK: não deixa nada no banco. Levanta EXCEPTION no
-- primeiro caso que divergir. Rodar colando no execute_sql do MCP.
BEGIN;

DO $$
DECLARE
  v_company uuid;
  v_admin   uuid;  -- is_superadmin
  v_ana     uuid;  -- colaboradora com docs_acesso
  v_beto    uuid;  -- colaborador com docs_acesso
  v_sem     uuid;  -- colaborador SEM docs_acesso
  v_client  uuid;
  v_conv    uuid;
  v_status  public.docs_conversa_status;
  v_dono    uuid;
  v_out_at  timestamptz;
  v_n       int;
  v_err     text;
BEGIN
  SELECT id INTO v_company FROM public.companies ORDER BY created_at LIMIT 1;

  SELECT u.id INTO v_admin FROM public.users u
   WHERE u.is_superadmin AND u.ativo AND NOT COALESCE(u.is_system_user, false) LIMIT 1;
  SELECT u.id INTO v_ana FROM public.users u
   WHERE NOT u.is_superadmin AND u.ativo AND NOT COALESCE(u.is_system_user, false)
   ORDER BY u.id LIMIT 1;
  SELECT u.id INTO v_beto FROM public.users u
   WHERE NOT u.is_superadmin AND u.ativo AND NOT COALESCE(u.is_system_user, false)
     AND u.id <> v_ana
   ORDER BY u.id LIMIT 1;
  SELECT u.id INTO v_sem FROM public.users u
   WHERE NOT u.is_superadmin AND u.ativo AND NOT COALESCE(u.is_system_user, false)
     AND u.id NOT IN (v_ana, v_beto)
   ORDER BY u.id LIMIT 1;

  IF v_company IS NULL OR v_admin IS NULL OR v_ana IS NULL OR v_beto IS NULL OR v_sem IS NULL THEN
    RAISE EXCEPTION 'FIXTURE: precisa de 1 admin e 3 colaboradores ativos';
  END IF;

  DELETE FROM public.user_permissions
   WHERE permission = 'docs_acesso' AND user_id IN (v_ana, v_beto, v_sem);
  INSERT INTO public.user_permissions (user_id, permission) VALUES
    (v_ana, 'docs_acesso'), (v_beto, 'docs_acesso');

  INSERT INTO public.clients (numero_whatsapp, nome, company_id)
  VALUES ('+5500000000077', 'TESTE docs', v_company)
  RETURNING id INTO v_client;

  -- 1) Documento do outro sistema: conversa nasce 'so_envio' e o documento NÃO
  --    conta como resposta (last_outbound_message_at fica nulo).
  INSERT INTO public.docs_conversas (company_id, client_id) VALUES (v_company, v_client)
  RETURNING id INTO v_conv;
  INSERT INTO public.docs_mensagens
    (company_id, conversa_id, direction, sender_type, tipo, content, media_url,
     media_metadata, uazapi_message_id, status_envio)
  VALUES (v_company, v_conv, 'outbound', 'externo', 'documento', NULL, 'https://x/boleto.pdf',
          '{"origem":"api_externa"}', 'teste:doc1', 'enviado');
  SELECT status, last_outbound_message_at INTO v_status, v_out_at
    FROM public.docs_conversas WHERE id = v_conv;
  IF v_status <> 'so_envio' OR v_out_at IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 1: esperado so_envio sem outbound humano, veio % / %', v_status, v_out_at;
  END IF;

  -- 2) Cliente responde: vira 'sem_dono' e gera evento 'reaberta'.
  INSERT INTO public.docs_mensagens
    (company_id, conversa_id, direction, sender_type, tipo, content, uazapi_message_id, status_envio)
  VALUES (v_company, v_conv, 'inbound', 'cliente', 'texto', 'recebi, mas o valor tá errado',
          'teste:in1', 'enviado');
  SELECT status INTO v_status FROM public.docs_conversas WHERE id = v_conv;
  IF v_status <> 'sem_dono' THEN
    RAISE EXCEPTION 'CASO 2: esperado sem_dono, veio %', v_status;
  END IF;
  SELECT count(*) INTO v_n FROM public.docs_eventos WHERE conversa_id = v_conv AND tipo = 'reaberta';
  IF v_n <> 1 THEN RAISE EXCEPTION 'CASO 2: esperado 1 evento reaberta, veio %', v_n; END IF;

  -- 3) Não lidas: a Ana vê 1 no total (conversa sem dono conta para todos).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ana)::text, true);
  IF public.get_my_docs_unread_total() <> 1 THEN
    RAISE EXCEPTION 'CASO 3: Ana deveria ter 1 não lida, veio %', public.get_my_docs_unread_total();
  END IF;

  -- 4) Quem não tem acesso não assume.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sem)::text, true);
  BEGIN
    PERFORM public.docs_assumir(v_conv);
    RAISE EXCEPTION 'CASO 4: sem acesso assumiu';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  -- 5) Colaborador sem dono não encerra direto da fila (vácuo de novo).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_beto)::text, true);
  BEGIN
    PERFORM public.docs_encerrar(v_conv);
    RAISE EXCEPTION 'CASO 5: encerrou sem ser dono';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  -- 6) Ana assume.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ana)::text, true);
  PERFORM public.docs_assumir(v_conv);
  SELECT status, assigned_to INTO v_status, v_dono FROM public.docs_conversas WHERE id = v_conv;
  IF v_status <> 'em_andamento' OR v_dono <> v_ana THEN
    RAISE EXCEPTION 'CASO 6: esperado em_andamento com Ana, veio % / %', v_status, v_dono;
  END IF;

  -- 7) Beto não toma de Ana.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_beto)::text, true);
  BEGIN
    PERFORM public.docs_assumir(v_conv);
    RAISE EXCEPTION 'CASO 7: Beto tomou a conversa da Ana';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL;
  END;

  -- 8) Só o dono escreve — garantido no banco.
  BEGIN
    INSERT INTO public.docs_mensagens
      (company_id, conversa_id, direction, sender_type, sent_by_user_id, tipo, content, status_envio)
    VALUES (v_company, v_conv, 'outbound', 'atendente', v_beto, 'texto', 'oi', 'enviando');
    RAISE EXCEPTION 'CASO 8: não-dono gravou mensagem';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  INSERT INTO public.docs_mensagens
    (company_id, conversa_id, direction, sender_type, sent_by_user_id, tipo, content, status_envio)
  VALUES (v_company, v_conv, 'outbound', 'atendente', v_ana, 'texto', 'Vou verificar!', 'enviando');
  SELECT last_outbound_message_at INTO v_out_at FROM public.docs_conversas WHERE id = v_conv;
  IF v_out_at IS NULL THEN RAISE EXCEPTION 'CASO 8: resposta da Ana não marcou outbound'; END IF;

  -- 9) Ana repassa: não para quem não tem acesso; sim para o Beto.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ana)::text, true);
  BEGIN
    PERFORM public.docs_repassar(v_conv, v_sem, NULL);
    RAISE EXCEPTION 'CASO 9: repassou para quem não tem acesso';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  PERFORM public.docs_repassar(v_conv, v_beto, 'boleto do mês 09');
  SELECT assigned_to INTO v_dono FROM public.docs_conversas WHERE id = v_conv;
  IF v_dono <> v_beto THEN RAISE EXCEPTION 'CASO 9: esperado Beto, veio %', v_dono; END IF;

  -- 10) Ana (ex-dona) já não repassa nem encerra.
  BEGIN
    PERFORM public.docs_encerrar(v_conv);
    RAISE EXCEPTION 'CASO 10: ex-dona encerrou';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  -- 11) Não-admin não mexe no acesso de ninguém.
  BEGIN
    PERFORM public.docs_definir_acesso(v_sem, true);
    RAISE EXCEPTION 'CASO 11: colaborador deu acesso';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  -- 12) Admin tira o acesso do Beto: a conversa dele volta para a fila.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  PERFORM public.docs_definir_acesso(v_beto, false);
  SELECT status, assigned_to INTO v_status, v_dono FROM public.docs_conversas WHERE id = v_conv;
  IF v_status <> 'sem_dono' OR v_dono IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 12: esperado sem_dono sem dono, veio % / %', v_status, v_dono;
  END IF;

  -- 13) Admin assume e encerra; mensagem antiga atrasada não reabre.
  PERFORM public.docs_assumir(v_conv);
  PERFORM public.docs_encerrar(v_conv);
  INSERT INTO public.docs_mensagens
    (company_id, conversa_id, direction, sender_type, tipo, content, uazapi_message_id,
     status_envio, created_at)
  VALUES (v_company, v_conv, 'inbound', 'cliente', 'texto', 'msg velha', 'teste:velha',
          'enviado', now() - interval '1 day');
  SELECT status INTO v_status FROM public.docs_conversas WHERE id = v_conv;
  IF v_status <> 'encerrada' THEN
    RAISE EXCEPTION 'CASO 13: mensagem atrasada reabriu (%)', v_status;
  END IF;

  -- 14) Mensagem nova do cliente reabre a encerrada.
  INSERT INTO public.docs_mensagens
    (company_id, conversa_id, direction, sender_type, tipo, content, uazapi_message_id, status_envio)
  VALUES (v_company, v_conv, 'inbound', 'cliente', 'texto', 'e aí?', 'teste:in2', 'enviado');
  SELECT status INTO v_status FROM public.docs_conversas WHERE id = v_conv;
  IF v_status <> 'sem_dono' THEN
    RAISE EXCEPTION 'CASO 14: esperado sem_dono, veio %', v_status;
  END IF;

  -- 15) Nova conversa: abre direto com quem pediu como dono.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ana)::text, true);
  IF public.docs_iniciar_conversa(v_client) <> v_conv THEN
    RAISE EXCEPTION 'CASO 15: iniciar devolveu outra conversa';
  END IF;
  SELECT assigned_to INTO v_dono FROM public.docs_conversas WHERE id = v_conv;
  IF v_dono <> v_ana THEN RAISE EXCEPTION 'CASO 15: esperado Ana como dona'; END IF;

  -- 16) Mensagem do Docs não se apaga por DELETE comum.
  BEGIN
    DELETE FROM public.docs_mensagens WHERE conversa_id = v_conv;
    RAISE EXCEPTION 'CASO 16: DELETE passou';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'DELETE em docs_mensagens%' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'docs_numero_financeiro: 16 casos OK';
END $$;

ROLLBACK;
