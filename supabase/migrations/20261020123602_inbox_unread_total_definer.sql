-- Contador de não lidas da Inbox sem RLS linha a linha.
--
-- Problema: get_my_inbox_unread_total era SECURITY INVOKER, então cada linha de
-- `atendimentos` e `mensagens` passava pelas policies — inclusive
-- private.can_read_atendimento_participante, chamada ~5 mil vezes por execução.
-- Resultado: ~9s por chamada (statement_timeout do authenticated é 8s). Com a
-- equipe toda logada (20/10/2026) o polling saturou o banco: 500 no contador e
-- também em /mensagens, e a Inbox ficava carregando para sempre.
--
-- Conserto: SECURITY DEFINER (mesmo padrão de mensagem_midia_visivel). A regra
-- de visibilidade fica explícita no WHERE: membro da empresa E (vê tudo nela OU
-- é o dono do atendimento em reservado/em_atendimento). A função só devolve um
-- número agregado do que o chamador já enxerga. auth.uid() continua sendo o do
-- chamador (lido do JWT).
--
-- Rollback: recriar a versão de 20260724120000_unread_counter_por_atendimento.sql
-- (SECURITY INVOKER, sem can_view_all_in).

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.get_my_inbox_unread_total()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  WITH eu AS (
    SELECT auth.uid() AS uid, public.current_user_can_view_all() AS ve_tudo
  ),
  visivel AS (
    SELECT DISTINCT ON (a.client_id)
      a.id, a.last_outbound_message_at
    FROM public.atendimentos a, eu
    WHERE
      public.is_member_of(a.company_id)
      AND (
        (eu.ve_tudo AND public.can_view_all_in(a.company_id))
        OR (a.assigned_to = eu.uid AND a.status IN ('reservado', 'em_atendimento'))
      )
    ORDER BY a.client_id, a.last_message_at DESC NULLS LAST, a.created_at DESC
  )
  SELECT COALESCE(SUM(cnt.unread), 0)::integer
  FROM visivel a
  CROSS JOIN eu
  LEFT JOIN public.atendimento_leituras rl
    ON rl.atendimento_id = a.id AND rl.user_id = eu.uid
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
$function$;

REVOKE EXECUTE ON FUNCTION public.get_my_inbox_unread_total() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_inbox_unread_total() TO authenticated;
