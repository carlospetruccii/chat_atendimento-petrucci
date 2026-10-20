-- RLS de leitura (atendimentos, mensagens, timeline_events) sem função por linha.
--
-- Problema (20/10/2026): as policies de SELECT chamavam is_member_of(company_id),
-- can_view_all_in(company_id), pendentes_abertos_a_todos(company_id) e
-- private.can_read_atendimento_participante(...) para CADA linha. Cada chamada é
-- plpgsql/SQL SECURITY DEFINER com consulta própria (~0,7–1,4ms). A lista de
-- mensagens custava ~1,2s, os contadores ~0,5s e, com polling de todas as abas,
-- o banco saturou: statement timeout (8s) em todas as telas.
--
-- Conserto: funções que devolvem ARRAYS com o que o usuário pode ver, chamadas
-- dentro de (SELECT ...) — o Postgres avalia uma vez por consulta (InitPlan) e
-- cada linha só faz `coluna = ANY(array)`. A regra de visibilidade é a MESMA:
--   minhas_empresas()            ≡ is_member_of(company_id)
--   empresas_ve_tudo()           ≡ can_view_all_in(company_id)
--   empresas_pendentes_abertos() ≡ pendentes_abertos_a_todos(company_id)
--   private.meus_atendimentos_participante() ≡ private.can_read_atendimento_participante
-- Qualquer mudança numa dessas regras precisa ser espelhada aqui.
--
-- Rollback: ALTER POLICY de volta para as expressões de
-- 20261016193222_colaborador_multiplos_departamentos.sql (atendimentos_select,
-- mensagens_select, timeline_events_select) e 20260901152202 (as *_participante).

SET LOCAL lock_timeout = '3s';

-- Empresas em que o usuário é membro ativo (todas se o enforcement está off).
CREATE OR REPLACE FUNCTION public.minhas_empresas()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN NOT public.auth_enforcement_enabled() THEN
      (SELECT coalesce(array_agg(DISTINCT m.company_id), '{}') FROM public.company_members m)
    ELSE
      (SELECT coalesce(array_agg(m.company_id), '{}') FROM public.company_members m
        WHERE m.user_id = auth.uid() AND m.ativo = true)
  END
$function$;

-- Empresas em que o usuário vê tudo (dono/administrador).
CREATE OR REPLACE FUNCTION public.empresas_ve_tudo()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN NOT public.auth_enforcement_enabled() THEN
      (SELECT coalesce(array_agg(DISTINCT m.company_id), '{}') FROM public.company_members m)
    ELSE
      (SELECT coalesce(array_agg(m.company_id), '{}') FROM public.company_members m
        WHERE m.user_id = auth.uid() AND m.ativo = true
          AND m.role IN ('dono', 'administrador'))
  END
$function$;

-- Empresas com pendentes abertos a todos os colaboradores.
CREATE OR REPLACE FUNCTION public.empresas_pendentes_abertos()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT coalesce(array_agg(c.company_id), '{}')
    FROM public.system_config c
   WHERE c.chave = 'pendentes_abertos_a_todos' AND c.valor = 'true'
     AND c.company_id IS NOT NULL
$function$;

-- Atendimentos em que o usuário é participante (dono ou citado na timeline).
CREATE OR REPLACE FUNCTION private.meus_atendimentos_participante()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT coalesce(array_agg(DISTINCT a.id), '{}')
    FROM public.atendimentos a
    JOIN public.company_members cm
      ON cm.company_id = a.company_id
     AND cm.user_id = (SELECT auth.uid())
     AND cm.ativo = true
    -- Desativar colaborador na tela só mexe em users.ativo, então os dois valem.
    JOIN public.users u
      ON u.id = cm.user_id
     AND u.ativo = true
     AND COALESCE(u.is_system_user, false) = false
   WHERE a.assigned_to = cm.user_id
      OR EXISTS (
        SELECT 1
          FROM public.timeline_events te
         WHERE te.atendimento_id = a.id
           AND te.company_id = a.company_id
           AND (te.actor_user_id = cm.user_id OR te.target_user_id = cm.user_id)
      )
$function$;

REVOKE EXECUTE ON FUNCTION public.minhas_empresas() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.empresas_ve_tudo() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.empresas_pendentes_abertos() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION private.meus_atendimentos_participante() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.minhas_empresas() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.empresas_ve_tudo() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.empresas_pendentes_abertos() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.meus_atendimentos_participante() TO authenticated, service_role;

-- atendimentos -------------------------------------------------------------
ALTER POLICY atendimentos_select ON public.atendimentos
  USING (
    company_id = ANY ((SELECT public.minhas_empresas())::uuid[])
    AND (
      company_id = ANY ((SELECT public.empresas_ve_tudo())::uuid[])
      OR assigned_to = (SELECT auth.uid())
      OR current_department_id = ANY ((SELECT public.meus_departamentos())::uuid[])
      OR (
        company_id = ANY ((SELECT public.empresas_pendentes_abertos())::uuid[])
        AND status = ANY (ARRAY['pendente'::public.status_atendimento, 'em_triagem'::public.status_atendimento])
        AND assigned_to IS NULL
      )
    )
  );

ALTER POLICY atendimentos_select_participante ON public.atendimentos
  USING (id = ANY ((SELECT private.meus_atendimentos_participante())::uuid[]));

-- mensagens ----------------------------------------------------------------
ALTER POLICY mensagens_select ON public.mensagens
  USING (
    company_id = ANY ((SELECT public.minhas_empresas())::uuid[])
    AND (
      company_id = ANY ((SELECT public.empresas_ve_tudo())::uuid[])
      OR department_id = ANY ((SELECT public.meus_departamentos())::uuid[])
      OR (
        company_id = ANY ((SELECT public.empresas_pendentes_abertos())::uuid[])
        AND EXISTS (
          SELECT 1 FROM public.atendimentos a
           WHERE a.id = mensagens.atendimento_id
             AND a.assigned_to IS NULL
             AND a.status = ANY (ARRAY['pendente'::public.status_atendimento, 'em_triagem'::public.status_atendimento])
        )
      )
    )
  );

ALTER POLICY mensagens_select_participante ON public.mensagens
  USING (atendimento_id = ANY ((SELECT private.meus_atendimentos_participante())::uuid[]));

-- timeline_events ----------------------------------------------------------
ALTER POLICY timeline_events_select ON public.timeline_events
  USING (
    company_id = ANY ((SELECT public.minhas_empresas())::uuid[])
    AND (
      company_id = ANY ((SELECT public.empresas_ve_tudo())::uuid[])
      OR EXISTS (
        SELECT 1 FROM public.atendimentos a
         WHERE a.id = timeline_events.atendimento_id
           AND a.current_department_id = ANY ((SELECT public.meus_departamentos())::uuid[])
      )
    )
  );

ALTER POLICY timeline_events_select_participante ON public.timeline_events
  USING (atendimento_id = ANY ((SELECT private.meus_atendimentos_participante())::uuid[]));
