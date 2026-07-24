-- ============================================================================
-- Fix: get_my_inbox_unread_total() somava TODOS os atendimentos encerrados
-- antigos de cada cliente, não só o mais recente (o único que a lista da
-- Inbox mostra de fato — listInboxConversations dedupa por client_id,
-- mantendo só o atendimento mais recente). Um cliente com vários atendimentos
-- encerrados antigos nunca lidos (porque nem aparecem na lista pra abrir)
-- inflava o badge do menu lateral pra sempre, sem forma de zerar via UI.
--
-- Também troca can_view_all_in(company_id) por current_user_can_view_all():
-- can_view_all_in() é permissivo pra TODO MUNDO enquanto o bridge multi-tenant
-- estiver em auth_enforcement_enabled = false (fase atual), então um atendente
-- comum (não-admin) somaria o total de TODOS os clientes, não só a própria
-- fila — current_user_can_view_all() é o mesmo helper de permissão
-- (is_superadmin/has_permission) que listInboxConversations já usa no client
-- pra decidir canViewAll, então replica o comportamento real de hoje.
-- is_member_of(company_id) continua como camada extra de isolamento por
-- empresa (hoje inofensivo, protege quando o bridge for ligado).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_my_inbox_unread_total()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH visivel AS (
    SELECT DISTINCT ON (a.client_id)
      a.id, a.company_id, a.last_outbound_message_at
    FROM public.atendimentos a
    WHERE
      public.is_member_of(a.company_id)
      AND (
        public.current_user_can_view_all()
        OR (a.assigned_to = auth.uid() AND a.status IN ('reservado', 'em_atendimento'))
      )
    ORDER BY a.client_id, a.last_message_at DESC NULLS LAST, a.created_at DESC
  )
  SELECT COALESCE(SUM(cnt.unread), 0)::integer
  FROM visivel a
  LEFT JOIN public.atendimento_leituras rl
    ON rl.atendimento_id = a.id AND rl.user_id = auth.uid()
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS unread
    FROM public.mensagens m
    WHERE m.atendimento_id = a.id
      AND m.direction = 'inbound'
      AND m.created_at > GREATEST(
        COALESCE(rl.last_read_at, '-infinity'::timestamptz),
        COALESCE(a.last_outbound_message_at, '-infinity'::timestamptz)
      )
  ) cnt ON true;
$$;
