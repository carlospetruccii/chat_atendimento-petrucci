-- ============================================================================
-- Grupos de WhatsApp no Inbox — estrutura PRÓPRIA, isolada do atendimento.
--
-- Por que tabelas separadas em vez de reaproveitar atendimentos/mensagens:
--   1. `atendimentos.client_id` e `mensagens.client_id` são NOT NULL apontando
--      para `clients`, que tem CHECK de E.164. O JID de grupo (`...@g.us`) não
--      passa nesse CHECK.
--   2. Grupo NÃO tem bot, triagem, departamento, atribuição nem encerramento.
--      Se as linhas de grupo morassem em `atendimentos`, TODA a maquinaria de
--      ticket (trigger de promoção, liberação ao desligar colaborador, os crons
--      de encerramento automático / alerta de parado / reativação de bot,
--      `vw_pendentes`, triagem-bot) precisaria de um filtro `is_grupo = false`.
--      Um filtro esquecido = bot mandando mensagem em grupo de cliente.
--      Com tabela separada isso é impossível por construção.
--
-- O que É reaproveitado: os enums de mensagem, o bucket `mensagens-midia`
-- (subpasta `grupos/`) e os componentes de UI.
-- ============================================================================

-- Quem falou numa mensagem de grupo:
--   participante → alguém do grupo (todo inbound);
--   atendente    → nós, pelo sistema (tem sent_by_user_id);
--   externo      → nós, pelo celular da empresa (fromMe fora do sistema);
--   sistema      → aviso gerado pelo próprio sistema.
-- Não existe 'bot': grupo não tem automação nenhuma.
DO $$ BEGIN
  CREATE TYPE public.grupo_sender_type AS ENUM ('participante','atendente','sistema','externo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ————————————————————————————————————————————————————————————————
-- 1) grupos — o "chat" de grupo. Espelha o que a uazapi devolve em
--    GET /group/list + POST /group/info.
-- ————————————————————————————————————————————————————————————————
CREATE TABLE IF NOT EXISTS public.grupos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT '11111111-1111-1111-1111-111111111111'::uuid
    REFERENCES public.companies(id) ON DELETE CASCADE,
  -- JID do grupo no WhatsApp, ex: '120363012345678901@g.us'. É a identidade.
  wa_jid text NOT NULL,
  nome text,
  topico text,
  foto_url text,
  participantes_total integer,
  -- Nosso número é admin do grupo? (usado só para exibir aviso na UI)
  sou_admin boolean NOT NULL DEFAULT false,
  -- Grupo em modo "somente admins enviam" (announce). Se true e sou_admin=false,
  -- a UI avisa que o envio vai falhar.
  somente_admin_envia boolean NOT NULL DEFAULT false,
  -- false = saímos/fomos removidos do grupo. Nunca apagamos: o histórico fica.
  ativo boolean NOT NULL DEFAULT true,
  last_message_at timestamptz,
  last_outbound_message_at timestamptz,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grupos_wa_jid_chk CHECK (wa_jid ~ '^[0-9]{5,}@g\.us$'),
  CONSTRAINT grupos_company_jid_key UNIQUE (company_id, wa_jid),
  -- Alvo da FK composta de grupo_mensagens / grupo_leituras: garante que uma
  -- mensagem só aponte para grupo da MESMA empresa.
  CONSTRAINT grupos_id_company_key UNIQUE (id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_grupos_company_last_message
  ON public.grupos (company_id, last_message_at DESC NULLS LAST);

DROP TRIGGER IF EXISTS trg_grupos_updated_at ON public.grupos;
CREATE TRIGGER trg_grupos_updated_at
  BEFORE UPDATE ON public.grupos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ————————————————————————————————————————————————————————————————
-- 2) grupo_mensagens — mensagens do grupo. Mesmo shape de `mensagens`, sem
--    atendimento/cliente/departamento, e com o participante que falou.
-- ————————————————————————————————————————————————————————————————
CREATE TABLE IF NOT EXISTS public.grupo_mensagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT '11111111-1111-1111-1111-111111111111'::uuid
    REFERENCES public.companies(id) ON DELETE CASCADE,
  grupo_id uuid NOT NULL REFERENCES public.grupos(id) ON DELETE CASCADE,
  direction public.direction_mensagem NOT NULL,
  sender_type public.grupo_sender_type NOT NULL,
  -- Preenchido quando quem enviou foi um atendente nosso pelo sistema.
  sent_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- Quem falou DENTRO do grupo (inbound), em E.164. O nome é o melhor rótulo
  -- disponível no momento da chegada (pushName da uazapi); a UI ainda cruza com
  -- os contatos do Google na hora de exibir.
  participante_numero text,
  participante_nome text,
  tipo public.tipo_mensagem NOT NULL,
  content text,
  media_url text,
  media_metadata jsonb,
  -- `id` da mensagem na uazapi (owner:messageid). Chave de idempotência.
  uazapi_message_id text,
  status_envio public.status_envio_mensagem NOT NULL DEFAULT 'aguardando_envio',
  status_whatsapp public.status_whatsapp_mensagem,
  reply_to_message_id uuid REFERENCES public.grupo_mensagens(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Inbound é sempre de um participante, sempre com número, nunca de um user nosso.
  CONSTRAINT grupo_mensagens_inbound_chk CHECK (
    direction <> 'inbound' OR (
      sender_type = 'participante'
      AND sent_by_user_id IS NULL
      AND participante_numero IS NOT NULL
    )
  ),
  -- Outbound é do atendente (com user) ou do sistema/celular da empresa (sem user).
  CONSTRAINT grupo_mensagens_outbound_chk CHECK (
    direction <> 'outbound' OR (
      sender_type IN ('atendente','sistema','externo')
      AND participante_numero IS NULL
      AND (sender_type = 'atendente') = (sent_by_user_id IS NOT NULL)
    )
  ),
  CONSTRAINT grupo_mensagens_participante_e164_chk CHECK (
    participante_numero IS NULL OR participante_numero ~ '^\+[1-9][0-9]{7,14}$'
  ),
  CONSTRAINT grupo_mensagens_texto_content_chk CHECK (
    tipo <> 'texto' OR content IS NOT NULL
  ),
  CONSTRAINT grupo_mensagens_media_url_chk CHECK (
    tipo IN ('texto','localizacao','contato') OR media_url IS NOT NULL
  ),
  CONSTRAINT grupo_mensagens_grupo_same_company_fk
    FOREIGN KEY (grupo_id, company_id) REFERENCES public.grupos(id, company_id)
);

-- Idempotência dos webhooks (reentrega da uazapi não duplica mensagem).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_grupo_mensagens_uazapi_message_id
  ON public.grupo_mensagens (uazapi_message_id)
  WHERE uazapi_message_id IS NOT NULL;

-- Paginação do chat (mais recentes primeiro).
CREATE INDEX IF NOT EXISTS idx_grupo_mensagens_grupo_created_at
  ON public.grupo_mensagens (grupo_id, created_at DESC);

-- Cauda não lida (mesma estratégia do contador de atendimentos).
CREATE INDEX IF NOT EXISTS idx_grupo_mensagens_grupo_inbound_created_at
  ON public.grupo_mensagens (grupo_id, created_at)
  WHERE direction = 'inbound';

CREATE INDEX IF NOT EXISTS idx_grupo_mensagens_company_id
  ON public.grupo_mensagens (company_id);

CREATE INDEX IF NOT EXISTS idx_grupo_mensagens_sent_by_user_id
  ON public.grupo_mensagens (sent_by_user_id);

CREATE INDEX IF NOT EXISTS idx_grupo_mensagens_reply_to
  ON public.grupo_mensagens (reply_to_message_id);

-- ————————————————————————————————————————————————————————————————
-- 3) grupo_leituras — estado de leitura por usuário (badge de não lidas).
--    Mesmo desenho de atendimento_leituras: escrita só via RPC SECURITY
--    DEFINER que fixa user_id = auth.uid(), então não há policy de escrita.
-- ————————————————————————————————————————————————————————————————
CREATE TABLE IF NOT EXISTS public.grupo_leituras (
  grupo_id uuid NOT NULL REFERENCES public.grupos(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grupo_id, user_id),
  CONSTRAINT grupo_leituras_grupo_same_company_fk
    FOREIGN KEY (grupo_id, company_id) REFERENCES public.grupos(id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_grupo_leituras_user_id ON public.grupo_leituras(user_id);
CREATE INDEX IF NOT EXISTS idx_grupo_leituras_company_id ON public.grupo_leituras(company_id);

-- ————————————————————————————————————————————————————————————————
-- 4) Carimbos de última mensagem — GREATEST para sobreviver a webhook fora de
--    ordem, igual ao trigger de atendimentos.
-- ————————————————————————————————————————————————————————————————
CREATE OR REPLACE FUNCTION public.update_grupo_last_message_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.grupos
    SET last_message_at = GREATEST(last_message_at, NEW.created_at),
        last_outbound_message_at = CASE
          WHEN NEW.direction = 'outbound'
            THEN GREATEST(last_outbound_message_at, NEW.created_at)
          ELSE last_outbound_message_at
        END
    WHERE id = NEW.grupo_id
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

DROP TRIGGER IF EXISTS trg_grupo_mensagens_last_message_at ON public.grupo_mensagens;
CREATE TRIGGER trg_grupo_mensagens_last_message_at
  AFTER INSERT ON public.grupo_mensagens
  FOR EACH ROW EXECUTE FUNCTION public.update_grupo_last_message_at();

-- ————————————————————————————————————————————————————————————————
-- 5) Mensagem de grupo é definitiva: identidade e conteúdo não mudam depois de
--    criados. O que PODE mudar é o resultado do envio e o download da mídia
--    (media_url / media_metadata / status_*), que chegam depois.
-- ————————————————————————————————————————————————————————————————
CREATE OR REPLACE FUNCTION public.protect_grupo_mensagem_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Backend (Edge Functions) precisa completar a linha depois: grava o
  -- uazapi_message_id do envio e o storage_path da mídia baixada.
  IF current_user = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id
     OR NEW.company_id <> OLD.company_id
     OR NEW.grupo_id <> OLD.grupo_id
     OR NEW.direction <> OLD.direction
     OR NEW.sender_type <> OLD.sender_type
     OR NEW.tipo <> OLD.tipo
     OR NEW.created_at <> OLD.created_at
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.participante_numero IS DISTINCT FROM OLD.participante_numero
     OR NEW.sent_by_user_id IS DISTINCT FROM OLD.sent_by_user_id
     OR (OLD.uazapi_message_id IS NOT NULL
         AND NEW.uazapi_message_id IS DISTINCT FROM OLD.uazapi_message_id)
  THEN
    RAISE EXCEPTION 'campos imutáveis de grupo_mensagens não podem ser alterados';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_grupo_mensagens_protect_immutable ON public.grupo_mensagens;
CREATE TRIGGER trg_grupo_mensagens_protect_immutable
  BEFORE UPDATE ON public.grupo_mensagens
  FOR EACH ROW EXECUTE FUNCTION public.protect_grupo_mensagem_immutable_fields();

CREATE OR REPLACE FUNCTION public.block_grupo_mensagem_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user = 'service_role' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'DELETE em grupo_mensagens é restrito a service_role';
END;
$$;

DROP TRIGGER IF EXISTS trg_grupo_mensagens_block_delete ON public.grupo_mensagens;
CREATE TRIGGER trg_grupo_mensagens_block_delete
  BEFORE DELETE ON public.grupo_mensagens
  FOR EACH ROW EXECUTE FUNCTION public.block_grupo_mensagem_delete();

-- ————————————————————————————————————————————————————————————————
-- 6) RLS — grupo é de TODOS os membros da empresa (decisão de produto: não há
--    atribuição de grupo a colaborador). Escrita de grupo e de mensagem é
--    exclusiva do backend (service_role, que ignora RLS): o frontend só envia
--    via Edge Function `grupo-enviar`, então não existe caminho para inserir
--    mensagem torta nem para forjar autoria.
-- ————————————————————————————————————————————————————————————————
ALTER TABLE public.grupos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grupo_mensagens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grupo_leituras ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS grupos_select ON public.grupos;
CREATE POLICY grupos_select ON public.grupos
  FOR SELECT TO authenticated USING (public.is_member_of(company_id));

DROP POLICY IF EXISTS grupo_mensagens_select ON public.grupo_mensagens;
CREATE POLICY grupo_mensagens_select ON public.grupo_mensagens
  FOR SELECT TO authenticated USING (public.is_member_of(company_id));

DROP POLICY IF EXISTS grupo_leituras_select ON public.grupo_leituras;
CREATE POLICY grupo_leituras_select ON public.grupo_leituras
  FOR SELECT TO authenticated
  USING (public.is_member_of(company_id) AND user_id = (SELECT auth.uid()));

-- ————————————————————————————————————————————————————————————————
-- 7) RPCs de não lidas — mesma regra do individual: conta INBOUND depois do
--    maior entre (a) minha última leitura e (b) a última mensagem OUTBOUND do
--    grupo (alguém do time respondeu → backlog endereçado para todos).
-- ————————————————————————————————————————————————————————————————
CREATE OR REPLACE FUNCTION public.get_grupos_unread_counts(p_grupo_ids uuid[])
RETURNS TABLE (grupo_id uuid, unread integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    g.id AS grupo_id,
    COALESCE(cnt.unread, 0)::integer AS unread
  FROM public.grupos g
  LEFT JOIN public.grupo_leituras rl
    ON rl.grupo_id = g.id AND rl.user_id = auth.uid()
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS unread
    FROM public.grupo_mensagens m
    WHERE m.grupo_id = g.id
      AND m.direction = 'inbound'
      AND m.created_at > GREATEST(
        COALESCE(rl.last_read_at, '-infinity'::timestamptz),
        COALESCE(g.last_outbound_message_at, '-infinity'::timestamptz)
      )
  ) cnt ON true
  WHERE g.id = ANY(p_grupo_ids);
$$;

REVOKE EXECUTE ON FUNCTION public.get_grupos_unread_counts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_grupos_unread_counts(uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_grupos_unread_total()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(cnt.unread), 0)::integer
  FROM public.grupos g
  LEFT JOIN public.grupo_leituras rl
    ON rl.grupo_id = g.id AND rl.user_id = auth.uid()
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS unread
    FROM public.grupo_mensagens m
    WHERE m.grupo_id = g.id
      AND m.direction = 'inbound'
      AND m.created_at > GREATEST(
        COALESCE(rl.last_read_at, '-infinity'::timestamptz),
        COALESCE(g.last_outbound_message_at, '-infinity'::timestamptz)
      )
  ) cnt ON true
  WHERE g.ativo = true AND public.is_member_of(g.company_id);
$$;

REVOKE EXECUTE ON FUNCTION public.get_my_grupos_unread_total() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_grupos_unread_total() TO authenticated;

CREATE OR REPLACE FUNCTION public.marcar_grupo_lido(p_grupo_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  SELECT company_id INTO v_company_id
  FROM public.grupos
  WHERE id = p_grupo_id;

  IF v_company_id IS NULL OR NOT public.is_member_of(v_company_id) THEN
    RETURN;
  END IF;

  INSERT INTO public.grupo_leituras (grupo_id, user_id, company_id, last_read_at)
  VALUES (p_grupo_id, auth.uid(), v_company_id, now())
  ON CONFLICT (grupo_id, user_id)
  DO UPDATE SET last_read_at = now();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.marcar_grupo_lido(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_grupo_lido(uuid) TO authenticated;

-- ————————————————————————————————————————————————————————————————
-- 8) Realtime — o Inbox escuta INSERT/UPDATE para atualizar lista e chat.
-- ————————————————————————————————————————————————————————————————
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'grupos'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.grupos';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'grupo_mensagens'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.grupo_mensagens';
  END IF;
END $$;
