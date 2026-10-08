-- Diz, para cada tempo da aba Configurações > Tempos, se ele faz efeito HOJE.
--
-- Motivo: os avisos "Sem efeito" eram texto fixo no frontend. Ligar ou desligar
-- um interruptor ou um cron não mudava nada na tela, e o navegador não consegue
-- ler cron.job para saber se a rotina roda. Agora a regra mora aqui e olha o
-- estado real:
--   - bot_ativo (kill switch: triagem-bot, alerta, aviso ao admin e
--     encerramento automático param quando está desligado);
--   - o job do pg_cron de cada edge function (active = true);
--   - interruptores próprios: triagem_abandono_ativo, encerramento_automatico_ativo;
--   - numero_whatsapp_admin preenchido (aviso ao admin);
--   - janela_continuidade_apos_encerramento = 0 é o desligado dela. Ela é lida
--     pelo webhook-zapi-receive, que não depende de bot_ativo nem de cron.
--
-- motivo NULL = o tempo faz efeito hoje. afetados = quantos clientes já passaram
-- do tempo do aviso ao responsável (para ninguém ligar o cron sem saber que vai
-- disparar uma enxurrada de avisos).
--
-- Só leitura. SECURITY DEFINER porque o usuário não lê cron.job; por isso a
-- função só responde para dono/administrador (can_manage_config_in), e sempre
-- sobre a empresa DELE (company_members), nunca uma empresa qualquer — mesmo com
-- auth_enforcement desligado. A contagem de afetados para em 500 (é RPC
-- chamável pelo cliente; o teto de tempo é o statement_timeout do papel
-- authenticated — SET statement_timeout na função não vale para a consulta que
-- já está rodando).
-- Tempo novo na tela (TEMPOS em src/lib/tempos-queries.ts) precisa de linha aqui.
-- Idempotente: CREATE OR REPLACE.

-- O job existe e está ligado no pg_cron. Separada para o teste conferir os
-- nomes dos jobs sem depender do estado do bot.
CREATE OR REPLACE FUNCTION public.status_tempos_cron_ativo(p_jobname text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = p_jobname AND j.active);
$$;

CREATE OR REPLACE FUNCTION public.status_tempos()
RETURNS TABLE (chave text, motivo text, afetados integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company uuid;
  v_cfg jsonb;
  v_bot boolean;
  v_alerta_min integer;
  v_afetados integer;
  c_teto_afetados constant int := 500;
  m_bot constant text := 'Sem efeito: o bot está desligado em Operação.';
  m_rotina constant text := 'Sem efeito: a rotina automática que usa este tempo está parada (%s).';
  m_triagem text;
  m_alerta text;
  m_admin text;
  m_encerramento text;
BEGIN
  -- Empresa do próprio usuário. Hoje não há troca de empresa na tela; quem é
  -- de mais de uma recebe sempre a mesma (menor id), de forma estável.
  SELECT m.company_id INTO v_company
    FROM public.company_members m
   WHERE m.user_id = auth.uid()
     AND m.ativo
     AND public.can_manage_config_in(m.company_id)
   ORDER BY m.company_id
   LIMIT 1;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'Sem acesso às configurações.' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_object_agg(sc.chave, btrim(coalesce(sc.valor, '')))
    INTO v_cfg
    FROM public.system_config sc
   WHERE sc.company_id = v_company;
  v_cfg := coalesce(v_cfg, '{}'::jsonb);
  -- Chave ausente = desligado, como o kill switch das edge functions.
  v_bot := coalesce(v_cfg->>'bot_ativo', '') = 'true';

  -- Primeiro motivo que trava cada rotina (NULL = roda).
  m_triagem := CASE
    WHEN NOT v_bot THEN m_bot
    WHEN NOT public.status_tempos_cron_ativo('triagem-bot')
      THEN format(m_rotina, 'triagem-bot')
  END;

  m_alerta := CASE
    WHEN NOT v_bot THEN m_bot
    WHEN NOT public.status_tempos_cron_ativo('cron-alerta-atendimento-parado')
      THEN format(m_rotina, 'cron-alerta-atendimento-parado')
  END;

  m_admin := CASE
    WHEN coalesce(v_cfg->>'numero_whatsapp_admin', '') = ''
      THEN 'Sem efeito: não há número de administrador cadastrado, então esse aviso nunca é enviado.'
    WHEN NOT v_bot THEN m_bot
    WHEN NOT public.status_tempos_cron_ativo('cron-notificacao-admin')
      THEN format(m_rotina, 'cron-notificacao-admin')
  END;

  m_encerramento := CASE
    WHEN coalesce(v_cfg->>'encerramento_automatico_ativo', '') <> 'true'
      THEN 'Sem efeito: o encerramento automático está desligado em Operação, então nenhum atendimento é encerrado por inatividade.'
    WHEN NOT v_bot THEN m_bot
    WHEN NOT public.status_tempos_cron_ativo('cron-encerramento-automatico')
      THEN format(m_rotina, 'cron-encerramento-automatico')
  END;

  -- Mesma regra do cron-alerta-atendimento-parado (get_atendimentos_parados),
  -- mas com teto de 500 em vez de 50: mostra o tamanho da fila sem custo aberto.
  v_alerta_min := CASE
    WHEN v_cfg->>'tempo_alerta_atendimento_parado' ~ '^\d{1,6}$'
     AND (v_cfg->>'tempo_alerta_atendimento_parado')::int > 0
      THEN (v_cfg->>'tempo_alerta_atendimento_parado')::int
    ELSE 90
  END;
  SELECT count(*)::int INTO v_afetados
    FROM (
      SELECT 1
        FROM public.atendimentos a
       WHERE a.company_id = v_company
         AND a.status IN ('pendente', 'em_triagem')
         AND a.created_at <= now() - make_interval(mins => v_alerta_min)
         AND public.minutos_uteis_decorridos(a.created_at, now(), a.current_department_id) >= v_alerta_min
       LIMIT c_teto_afetados
    ) x;

  RETURN QUERY VALUES
    ('delay_anti_flood_triagem'::text, m_triagem, NULL::integer),
    ('triagem_max_tentativas', m_triagem, NULL),
    ('tempo_abandono_triagem', coalesce(m_triagem, CASE
       WHEN coalesce(v_cfg->>'triagem_abandono_ativo', '') <> 'true'
         THEN 'Sem efeito: o encerramento de triagem abandonada está desligado, então nenhuma triagem é encerrada por silêncio do cliente.'
     END), NULL),
    ('janela_continuidade_apos_encerramento', CASE
       WHEN v_cfg->>'janela_continuidade_apos_encerramento' = '0'
         THEN 'Desligado: todo cliente que responder depois de um atendimento encerrado passa pelo menu de setores de novo.'
     END, NULL),
    ('tempo_alerta_atendimento_parado', m_alerta, v_afetados),
    ('intervalo_repeticao_alerta_atendimento_parado', m_alerta, NULL),
    ('tempo_notificacao_admin', m_admin, NULL),
    ('intervalo_repeticao_notificacao_admin', m_admin, NULL),
    ('tempo_encerramento_automatico', m_encerramento, NULL);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.status_tempos() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.status_tempos() TO authenticated;

-- Auxiliar interna: só a status_tempos() usa (roda como dona da função).
REVOKE EXECUTE ON FUNCTION public.status_tempos_cron_ativo(text) FROM PUBLIC, anon, authenticated;
