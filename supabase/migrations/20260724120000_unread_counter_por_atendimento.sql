-- ============================================================================
-- Contador de mensagens não lidas por atendimento (badge estilo WhatsApp).
--
-- Regra: unread(atendimento, usuário) = nº de mensagens INBOUND com created_at
-- posterior ao maior entre (a) o último last_read_at do usuário para esse
-- atendimento e (b) a última mensagem OUTBOUND do atendimento (uma resposta de
-- qualquer atendente zera o contador para todo mundo, já que sinaliza que o
-- backlog foi endereçado).
-- ============================================================================

-- 1) Estado de leitura por usuário. Escrita só via marcar_atendimento_lido()
--    (SECURITY DEFINER, fixa user_id = auth.uid()); por isso não há política de
--    INSERT/UPDATE — só SELECT, para os RPCs conseguirem enxergar a própria linha.
CREATE TABLE public.atendimento_leituras (
  atendimento_id uuid NOT NULL REFERENCES public.atendimentos(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (atendimento_id, user_id)
);

ALTER TABLE public.atendimento_leituras
  ADD CONSTRAINT atendimento_leituras_atend_same_company_fk
  FOREIGN KEY (atendimento_id, company_id) REFERENCES public.atendimentos(id, company_id);

-- Índices das FKs (user_id / company_id não são o líder da PK).
CREATE INDEX idx_atendimento_leituras_user_id ON public.atendimento_leituras(user_id);
CREATE INDEX idx_atendimento_leituras_company_id ON public.atendimento_leituras(company_id);

ALTER TABLE public.atendimento_leituras ENABLE ROW LEVEL SECURITY;

CREATE POLICY atendimento_leituras_select ON public.atendimento_leituras
  FOR SELECT TO authenticated
  USING (public.is_member_of(company_id) AND user_id = (SELECT auth.uid()));

-- 2) Carimbo da última mensagem OUTBOUND por atendimento (espelha
--    last_message_at, que já existe e é mantido pelo mesmo trigger).
ALTER TABLE public.atendimentos ADD COLUMN IF NOT EXISTS last_outbound_message_at timestamptz;

-- Índice parcial: só mensagens inbound importam para o cálculo de "unread",
-- e é sobre elas que os RPCs abaixo fazem um range scan por atendimento.
CREATE INDEX idx_mensagens_atendimento_inbound_created_at
  ON public.mensagens (atendimento_id, created_at)
  WHERE direction = 'inbound';

-- Backfill de last_outbound_message_at: sem isso, toda conversa existente
-- apareceria com last_outbound = NULL (equivalente a "nunca respondida").
UPDATE public.atendimentos a
SET last_outbound_message_at = sub.max_created_at
FROM (
  SELECT atendimento_id, MAX(created_at) AS max_created_at
  FROM public.mensagens
  WHERE direction = 'outbound'
  GROUP BY atendimento_id
) sub
WHERE sub.atendimento_id = a.id;

-- Backfill de atendimento_leituras: sem isso, todo atendimento já atribuído
-- apareceria pro seu responsável atual com o backlog INBOUND inteiro como
-- "não lido" no primeiro carregamento pós-deploy (ninguém tinha last_read_at
-- ainda). Marca como lido AGORA só para quem já está com o atendimento —
-- outros usuários (ex.: admin em supervisão) continuam vendo a contagem real.
INSERT INTO public.atendimento_leituras (atendimento_id, user_id, company_id, last_read_at)
SELECT a.id, a.assigned_to, a.company_id, now()
FROM public.atendimentos a
WHERE a.assigned_to IS NOT NULL
ON CONFLICT (atendimento_id, user_id) DO NOTHING;

-- Cada stamp (last_message_at / last_outbound_message_at) agora avança de
-- forma independente e monotônica via GREATEST, então a ordem de chegada das
-- linhas (webhooks/retries fora de ordem entre uazapi e Meta Cloud API) não
-- derruba o carimbo de outbound: cada coluna só é tocada quando a própria
-- mensagem é mais nova que o que já está gravado NAQUELA coluna.
CREATE OR REPLACE FUNCTION public.update_atendimento_last_message_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.atendimentos
    SET last_message_at = GREATEST(last_message_at, NEW.created_at),
        last_outbound_message_at = CASE
          WHEN NEW.direction = 'outbound'
            THEN GREATEST(last_outbound_message_at, NEW.created_at)
          ELSE last_outbound_message_at
        END
    WHERE id = NEW.atendimento_id
      AND (
        last_message_at IS NULL OR last_message_at < NEW.created_at
        OR (
          NEW.direction = 'outbound'
          AND (last_outbound_message_at IS NULL OR last_outbound_message_at < NEW.created_at)
        )
      );
  RETURN NEW;
END;
$$;

-- 3) RPC: contagem de não lidas para um lote de atendimentos (usado pela lista
--    da Inbox). SECURITY INVOKER — só enxerga o que o próprio usuário já tem
--    acesso via RLS de mensagens/atendimentos. LATERAL + índice parcial acima
--    transformam isso num range scan pela "cauda" não lida, em vez de
--    varrer o histórico inteiro de mensagens de cada atendimento.
CREATE OR REPLACE FUNCTION public.get_atendimentos_unread_counts(p_atendimento_ids uuid[])
RETURNS TABLE (atendimento_id uuid, unread integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    a.id AS atendimento_id,
    COALESCE(cnt.unread, 0)::integer AS unread
  FROM public.atendimentos a
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
  ) cnt ON true
  WHERE a.id = ANY(p_atendimento_ids);
$$;

REVOKE EXECUTE ON FUNCTION public.get_atendimentos_unread_counts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_atendimentos_unread_counts(uuid[]) TO authenticated;

-- 4) RPC: total de não lidas do usuário, para o badge do menu lateral. Replica
--    a regra de visibilidade de listInboxConversations (client-side) usando os
--    helpers multi-tenant atuais (is_member_of/can_view_all_in, por empresa) —
--    NUNCA current_user_can_view_all()/current_user_is_superadmin(), que são o
--    helper legado pré-multi-tenant: são globais, ignoram company_id e nunca
--    checam auth_enforcement_enabled, então vazariam contagem de não lidas de
--    OUTRAS empresas para qualquer dono/administrador.
CREATE OR REPLACE FUNCTION public.get_my_inbox_unread_total()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(cnt.unread), 0)::integer
  FROM public.atendimentos a
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
  ) cnt ON true
  WHERE
    public.is_member_of(a.company_id)
    AND (
      public.can_view_all_in(a.company_id)
      OR (a.assigned_to = auth.uid() AND a.status IN ('reservado', 'em_atendimento'))
    );
$$;

REVOKE EXECUTE ON FUNCTION public.get_my_inbox_unread_total() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_inbox_unread_total() TO authenticated;

-- 5) RPC: marca o atendimento como lido para o chamador. SECURITY DEFINER só
--    para poder ler company_id e gravar em atendimento_leituras (que não tem
--    política de escrita própria); user_id vem sempre de auth.uid(), nunca de
--    parâmetro, então ninguém marca leitura em nome de outro usuário.
CREATE OR REPLACE FUNCTION public.marcar_atendimento_lido(p_atendimento_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  SELECT company_id INTO v_company_id
  FROM public.atendimentos
  WHERE id = p_atendimento_id;

  IF v_company_id IS NULL OR NOT public.is_member_of(v_company_id) THEN
    RETURN;
  END IF;

  INSERT INTO public.atendimento_leituras (atendimento_id, user_id, company_id, last_read_at)
  VALUES (p_atendimento_id, auth.uid(), v_company_id, now())
  ON CONFLICT (atendimento_id, user_id)
  DO UPDATE SET last_read_at = now();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.marcar_atendimento_lido(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_atendimento_lido(uuid) TO authenticated;
