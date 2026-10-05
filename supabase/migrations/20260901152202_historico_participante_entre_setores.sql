-- Mantém o histórico visível para quem participou do atendimento mesmo quando
-- uma transferência muda o departamento atual. As policies são ADITIVAS: não
-- alteram as regras atuais de administrador, setor ou pendente.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE CREATE ON SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE USAGE ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.can_read_atendimento_participante(
  p_atendimento_id uuid,
  p_company_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.atendimentos a
      JOIN public.company_members cm
        ON cm.company_id = a.company_id
       AND cm.user_id = (SELECT auth.uid())
       AND cm.ativo = true
      -- Desativar colaborador na tela só mexe em users.ativo (company_members
      -- continua ativo), então os dois precisam valer — igual a _shared/empresa.ts.
      JOIN public.users u
        ON u.id = cm.user_id
       AND u.ativo = true
       AND COALESCE(u.is_system_user, false) = false
      WHERE a.id = p_atendimento_id
        AND a.company_id = p_company_id
        AND (
          a.assigned_to = cm.user_id
          OR EXISTS (
            SELECT 1
            FROM public.timeline_events te
            WHERE te.atendimento_id = a.id
              AND te.company_id = a.company_id
              AND (
                te.actor_user_id = cm.user_id
                OR te.target_user_id = cm.user_id
              )
          )
        )
    );
$$;

COMMENT ON FUNCTION private.can_read_atendimento_participante(uuid, uuid) IS
  'Autoriza leitura do atendimento completo para membro ativo (company_members e users) que foi responsável, ator ou destino na timeline; não depende do bridge auth_enforcement_enabled.';

REVOKE ALL ON FUNCTION private.can_read_atendimento_participante(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_read_atendimento_participante(uuid, uuid)
  TO authenticated;

-- Eventos de timeline são evidência de participação. Impede que clientes REST
-- fabriquem essa evidência; Edge Functions service_role, triggers e RPCs
-- SECURITY DEFINER continuam registrando os eventos legítimos.
REVOKE INSERT ON public.timeline_events FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS atendimentos_select_participante ON public.atendimentos;
CREATE POLICY atendimentos_select_participante
  ON public.atendimentos
  FOR SELECT
  TO authenticated
  USING (
    (SELECT private.can_read_atendimento_participante(id, company_id))
  );

DROP POLICY IF EXISTS mensagens_select_participante ON public.mensagens;
CREATE POLICY mensagens_select_participante
  ON public.mensagens
  FOR SELECT
  TO authenticated
  USING (
    (SELECT private.can_read_atendimento_participante(atendimento_id, company_id))
  );

DROP POLICY IF EXISTS timeline_events_select_participante ON public.timeline_events;
CREATE POLICY timeline_events_select_participante
  ON public.timeline_events
  FOR SELECT
  TO authenticated
  USING (
    (SELECT private.can_read_atendimento_participante(atendimento_id, company_id))
  );
