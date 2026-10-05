-- ============================================================================
-- Aba "Docs" — conversas do número FINANCEIRO (segunda instância uazapi).
--
-- O número financeiro é usado por outro sistema para disparar documentos aos
-- clientes. Quem responde a esses documentos ficava sem ninguém ver. A aba Docs
-- mostra essas conversas com a mesma cara da Inbox, mas SEM triagem, bot ou
-- automação nenhuma.
--
-- Por que tabelas próprias (mesmo raciocínio de grupos, 20260727120900):
--   Nenhum cron, a triagem, Pendentes, Supervisão, Dashboard nem os contadores
--   filtram `atendimentos` por canal. Se estas conversas morassem lá, qualquer
--   filtro esquecido = bot mandando triagem pelo número errado ou conversa do
--   financeiro caindo na fila da Inbox. Com tabela separada isso é impossível
--   por construção. O cadastro de cliente (`clients`) é o MESMO: nome e contato
--   ficam unificados entre as duas abas.
--
-- Regras de produto (decididas com o João em 29/09/2026):
--   - Toda conversa do número aparece na lista, até as que só receberam
--     documento (status 'so_envio').
--   - Cliente escreveu numa conversa 'so_envio' ou 'encerrada' → 'sem_dono'.
--   - Alguém assume → 'em_andamento' com dono. Só o dono escreve. Repassa e
--     encerra como na Inbox.
--   - Quem tem acesso (admin ou permissão `docs_acesso`) vê TODAS as conversas.
--   - Repassar e encerrar: só o dono ou um admin (igual à Inbox). Conversa sem
--     dono precisa ser assumida antes — encerrar da fila deixaria o cliente no
--     vácuo de novo, que é exatamente o problema que esta aba resolve.
--
-- Rollback (runbook, desfaz a feature inteira):
--   DROP POLICY IF EXISTS "docs_midia_select_acesso" ON storage.objects;
--   DROP POLICY IF EXISTS user_permissions_docs_acesso_so_rpc_ins ON public.user_permissions;
--   DROP POLICY IF EXISTS user_permissions_docs_acesso_so_rpc_del ON public.user_permissions;
--   DROP TRIGGER IF EXISTS trg_user_permissions_docs_soltar ON public.user_permissions;
--   DROP TRIGGER IF EXISTS trg_users_docs_soltar ON public.users;
--   DROP TABLE IF EXISTS public.docs_eventos, public.docs_leituras,
--     public.docs_mensagens, public.docs_conversas;
--   DROP FUNCTION IF EXISTS public.docs_definir_acesso(uuid, boolean),
--     public.docs_listar_acesso(), public.marcar_docs_conversa_lida(uuid),
--     public.get_my_docs_unread_total(), public.get_docs_unread_counts(uuid[]),
--     public.docs_iniciar_conversa(uuid), public.docs_encerrar(uuid),
--     public.docs_repassar(uuid, uuid, text), public.docs_assumir(uuid),
--     public.docs_soltar_conversas_sem_acesso(uuid),
--     public.trg_user_permissions_docs_soltar(), public.trg_users_docs_soltar(),
--     public.docs_mensagem_antes_insert(), public.docs_mensagem_apos_insert(),
--     public.block_docs_mensagem_delete(), public.docs_midia_visivel(text),
--     public.pode_acessar_docs(),
--     public.usuario_pode_acessar_docs(uuid);
--   DROP TYPE IF EXISTS public.docs_conversa_status;
--   DELETE FROM public.user_permissions WHERE permission = 'docs_acesso';
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE public.docs_conversa_status AS ENUM
    ('so_envio', 'sem_dono', 'em_andamento', 'encerrada');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ————————————————————————————————————————————————————————————————
-- 1) Quem pode acessar o Docs.
--    Admin (is_superadmin) sempre; colaborador só com a permissão
--    `docs_acesso`. Diferente de `is_member_of`, isto NÃO depende da trava
--    auth_enforcement_enabled: é controle de acesso real desde já.
-- ————————————————————————————————————————————————————————————————
CREATE OR REPLACE FUNCTION public.usuario_pode_acessar_docs(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.id = p_user_id
      AND u.ativo = true
      AND COALESCE(u.is_system_user, false) = false
      AND (
        u.is_superadmin = true
        OR EXISTS (
          SELECT 1 FROM public.user_permissions p
          WHERE p.user_id = u.id AND p.permission = 'docs_acesso'
        )
      )
  )
$$;

-- Interna: consultar o acesso de OUTRA pessoa é coisa das RPCs abaixo e das
-- Edge Functions do Docs (service_role).
REVOKE EXECUTE ON FUNCTION public.usuario_pode_acessar_docs(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.usuario_pode_acessar_docs(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.pode_acessar_docs()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.usuario_pode_acessar_docs(auth.uid())
$$;

REVOKE EXECUTE ON FUNCTION public.pode_acessar_docs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pode_acessar_docs() TO authenticated;

-- ————————————————————————————————————————————————————————————————
-- 2) docs_conversas — 1 por cliente no número financeiro.
-- ————————————————————————————————————————————————————————————————
CREATE TABLE IF NOT EXISTS public.docs_conversas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT '11111111-1111-1111-1111-111111111111'::uuid
    REFERENCES public.companies(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  status public.docs_conversa_status NOT NULL DEFAULT 'so_envio',
  -- RESTRICT: o CHECK do dono não aceitaria o SET NULL; desligar colaborador é
  -- por `ativo = false`, que solta a conversa pelo gatilho da seção 7b.
  assigned_to uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  assigned_at timestamptz,
  closed_at timestamptz,
  closed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT docs_conversas_company_client_key UNIQUE (company_id, client_id),
  -- RESTRICT (igual a atendimentos/mensagens): apagar o cadastro do cliente não
  -- pode levar junto o histórico do Docs. Composta: cliente da MESMA empresa.
  CONSTRAINT docs_conversas_client_same_company_fk
    FOREIGN KEY (client_id, company_id) REFERENCES public.clients(id, company_id)
    ON DELETE RESTRICT,
  CONSTRAINT docs_conversas_id_company_key UNIQUE (id, company_id),
  -- Dono existe se, e somente se, a conversa está em andamento. Encerrar ou
  -- voltar para a fila sempre solta o dono.
  CONSTRAINT docs_conversas_dono_chk CHECK (
    (status = 'em_andamento') = (assigned_to IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_docs_conversas_company_last_message
  ON public.docs_conversas (company_id, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_docs_conversas_assigned_to
  ON public.docs_conversas (assigned_to);
CREATE INDEX IF NOT EXISTS idx_docs_conversas_client_company
  ON public.docs_conversas (client_id, company_id);
CREATE INDEX IF NOT EXISTS idx_docs_conversas_closed_by
  ON public.docs_conversas (closed_by_user_id);

DROP TRIGGER IF EXISTS trg_docs_conversas_updated_at ON public.docs_conversas;
CREATE TRIGGER trg_docs_conversas_updated_at
  BEFORE UPDATE ON public.docs_conversas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ————————————————————————————————————————————————————————————————
-- 3) docs_mensagens — mesmo shape de `mensagens`/`grupo_mensagens`.
--    sender_type reaproveita o enum da Inbox (a UI já sabe desenhar), sem 'bot'.
--      cliente   → inbound
--      atendente → nós, pela aba Docs (tem sent_by_user_id)
--      externo   → o outro sistema (documento) ou o celular do financeiro;
--                  media_metadata.origem diz qual ('api_externa' | 'celular')
-- ————————————————————————————————————————————————————————————————
CREATE TABLE IF NOT EXISTS public.docs_mensagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT '11111111-1111-1111-1111-111111111111'::uuid
    REFERENCES public.companies(id) ON DELETE CASCADE,
  conversa_id uuid NOT NULL,
  direction public.direction_mensagem NOT NULL,
  sender_type public.sender_type NOT NULL,
  sent_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  tipo public.tipo_mensagem NOT NULL,
  content text,
  media_url text,
  media_metadata jsonb,
  -- `id` da mensagem na uazapi (owner:messageid). Chave de idempotência.
  uazapi_message_id text,
  status_envio public.status_envio_mensagem NOT NULL DEFAULT 'aguardando_envio',
  status_whatsapp public.status_whatsapp_mensagem,
  reply_to_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  apagada_em timestamptz,
  apagada_por_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  editada_em timestamptz,
  conteudo_anterior text,

  CONSTRAINT docs_mensagens_id_conversa_key UNIQUE (id, conversa_id),
  CONSTRAINT docs_mensagens_conversa_same_company_fk
    FOREIGN KEY (conversa_id, company_id)
    REFERENCES public.docs_conversas(id, company_id) ON DELETE CASCADE,
  -- Citação amarrada à MESMA conversa (lição de grupos, 20260727140000).
  CONSTRAINT docs_mensagens_reply_same_conversa_fk
    FOREIGN KEY (reply_to_message_id, conversa_id)
    REFERENCES public.docs_mensagens(id, conversa_id)
    ON DELETE SET NULL (reply_to_message_id),

  CONSTRAINT docs_mensagens_sender_chk CHECK (sender_type <> 'bot'),
  CONSTRAINT docs_mensagens_inbound_chk CHECK (
    direction <> 'inbound' OR (sender_type = 'cliente' AND sent_by_user_id IS NULL)
  ),
  CONSTRAINT docs_mensagens_outbound_chk CHECK (
    direction <> 'outbound' OR (
      sender_type IN ('atendente', 'sistema', 'externo')
      AND (sender_type = 'atendente') = (sent_by_user_id IS NOT NULL)
    )
  ),
  CONSTRAINT docs_mensagens_texto_content_chk CHECK (
    tipo <> 'texto' OR content IS NOT NULL OR apagada_em IS NOT NULL
  ),
  CONSTRAINT docs_mensagens_media_url_chk CHECK (
    tipo IN ('texto', 'localizacao', 'contato')
    OR media_url IS NOT NULL
    OR apagada_em IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_docs_mensagens_uazapi_message_id
  ON public.docs_mensagens (uazapi_message_id)
  WHERE uazapi_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_docs_mensagens_conversa_created_at
  ON public.docs_mensagens (conversa_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_docs_mensagens_conversa_inbound_created_at
  ON public.docs_mensagens (conversa_id, created_at)
  WHERE direction = 'inbound';

CREATE INDEX IF NOT EXISTS idx_docs_mensagens_company_id
  ON public.docs_mensagens (company_id);
CREATE INDEX IF NOT EXISTS idx_docs_mensagens_sent_by_user_id
  ON public.docs_mensagens (sent_by_user_id);
CREATE INDEX IF NOT EXISTS idx_docs_mensagens_apagada_por
  ON public.docs_mensagens (apagada_por_user_id);
CREATE INDEX IF NOT EXISTS idx_docs_mensagens_reply_conversa
  ON public.docs_mensagens (reply_to_message_id, conversa_id);

-- A policy de Storage da mídia do Docs procura a mensagem pelo storage_path.
CREATE INDEX IF NOT EXISTS idx_docs_mensagens_storage_path
  ON public.docs_mensagens ((media_metadata->>'storage_path'));

-- Varredura de envio incerto do cron-retry-mensagens-falha (espelha
-- idx_grupo_mensagens_envio_incerto).
CREATE INDEX IF NOT EXISTS idx_docs_mensagens_envio_incerto
  ON public.docs_mensagens ((media_metadata->>'envio_incerto_em'))
  WHERE status_envio = 'enviando' AND uazapi_message_id IS NULL;

-- ————————————————————————————————————————————————————————————————
-- 4) docs_leituras — não lidas por pessoa. Escrita só pela RPC.
-- ————————————————————————————————————————————————————————————————
CREATE TABLE IF NOT EXISTS public.docs_leituras (
  conversa_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversa_id, user_id),
  CONSTRAINT docs_leituras_conversa_same_company_fk
    FOREIGN KEY (conversa_id, company_id)
    REFERENCES public.docs_conversas(id, company_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_docs_leituras_user_id ON public.docs_leituras(user_id);
CREATE INDEX IF NOT EXISTS idx_docs_leituras_company_id ON public.docs_leituras(company_id);

-- ————————————————————————————————————————————————————————————————
-- 5) docs_eventos — histórico de quem assumiu, repassou, encerrou.
--    Append-only: só as RPCs/gatilho (SECURITY DEFINER) escrevem.
-- ————————————————————————————————————————————————————————————————
CREATE TABLE IF NOT EXISTS public.docs_eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  conversa_id uuid NOT NULL,
  tipo text NOT NULL,
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  target_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  observacao text,
  -- Claim do aviso de repasse no WhatsApp pessoal (docs-notificar-repasse):
  -- no máximo 1 aviso por evento, mesmo com clique duplo.
  notificado_em timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT docs_eventos_tipo_chk CHECK (
    tipo IN ('iniciada', 'assumida', 'repassada', 'encerrada', 'reaberta')
  ),
  CONSTRAINT docs_eventos_observacao_len_chk CHECK (
    observacao IS NULL OR char_length(observacao) <= 500
  ),
  CONSTRAINT docs_eventos_conversa_same_company_fk
    FOREIGN KEY (conversa_id, company_id)
    REFERENCES public.docs_conversas(id, company_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_docs_eventos_conversa_created
  ON public.docs_eventos (conversa_id, created_at);
CREATE INDEX IF NOT EXISTS idx_docs_eventos_company_id ON public.docs_eventos(company_id);
CREATE INDEX IF NOT EXISTS idx_docs_eventos_actor ON public.docs_eventos(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_docs_eventos_target ON public.docs_eventos(target_user_id);

-- ————————————————————————————————————————————————————————————————
-- 6) Gatilhos de docs_mensagens.
-- ————————————————————————————————————————————————————————————————

-- "Só o dono escreve" garantido no banco, não só na Edge Function: a checagem
-- acontece no mesmo instante do INSERT, então um repasse no meio do envio não
-- deixa passar mensagem de quem acabou de perder a conversa.
CREATE OR REPLACE FUNCTION public.docs_mensagem_antes_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sender_type = 'atendente' AND NOT EXISTS (
    SELECT 1 FROM public.docs_conversas c
    WHERE c.id = NEW.conversa_id
      AND c.status = 'em_andamento'
      AND c.assigned_to = NEW.sent_by_user_id
  ) THEN
    RAISE EXCEPTION 'Só o dono da conversa pode enviar mensagem' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.docs_mensagem_antes_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_docs_mensagens_antes_insert ON public.docs_mensagens;
CREATE TRIGGER trg_docs_mensagens_antes_insert
  BEFORE INSERT ON public.docs_mensagens
  FOR EACH ROW EXECUTE FUNCTION public.docs_mensagem_antes_insert();

-- Carimbos de última mensagem + transição de status quando o CLIENTE escreve.
-- Mora no banco para ser atômico e não depender de quem insere lembrar da regra.
--
-- `last_outbound_message_at` é o marco de "alguém respondeu" das não lidas, então
-- só conta resposta de gente: atendente pela aba, ou o celular do financeiro.
-- Documento disparado pelo outro sistema NÃO conta — senão a resposta do
-- cliente sumiria do contador assim que outro documento saísse.
CREATE OR REPLACE FUNCTION public.docs_mensagem_apos_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv public.docs_conversas%ROWTYPE;
  v_reabre boolean;
  v_resposta_humana boolean;
BEGIN
  -- NO KEY UPDATE, não FOR UPDATE: o próprio INSERT já segura KEY SHARE na
  -- conversa pela FK, e FOR UPDATE conflitaria com o KEY SHARE de outro INSERT
  -- simultâneo (álbum de fotos) → deadlock e mensagem perdida.
  SELECT * INTO v_conv FROM public.docs_conversas WHERE id = NEW.conversa_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.direction = 'inbound' THEN
    -- Mensagem antiga chegando atrasada não reabre o que já foi encerrado depois.
    v_reabre := v_conv.status IN ('so_envio', 'encerrada')
      AND NEW.created_at >= COALESCE(v_conv.closed_at, '-infinity'::timestamptz);

    UPDATE public.docs_conversas
      SET last_message_at = GREATEST(COALESCE(last_message_at, NEW.created_at), NEW.created_at),
          last_inbound_at = GREATEST(COALESCE(last_inbound_at, NEW.created_at), NEW.created_at),
          status = CASE WHEN v_reabre THEN 'sem_dono'::public.docs_conversa_status ELSE status END,
          closed_at = CASE WHEN v_reabre THEN NULL ELSE closed_at END,
          closed_by_user_id = CASE WHEN v_reabre THEN NULL ELSE closed_by_user_id END
      WHERE id = NEW.conversa_id;

    IF v_reabre THEN
      INSERT INTO public.docs_eventos (company_id, conversa_id, tipo)
      VALUES (NEW.company_id, NEW.conversa_id, 'reaberta');
    END IF;
  ELSE
    v_resposta_humana := NEW.sender_type = 'atendente'
      OR (NEW.sender_type = 'externo' AND NEW.media_metadata->>'origem' = 'celular');

    UPDATE public.docs_conversas
      SET last_message_at = GREATEST(COALESCE(last_message_at, NEW.created_at), NEW.created_at),
          last_outbound_message_at = CASE
            WHEN v_resposta_humana THEN GREATEST(
              COALESCE(last_outbound_message_at, NEW.created_at), NEW.created_at
            )
            ELSE last_outbound_message_at
          END
      WHERE id = NEW.conversa_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.docs_mensagem_apos_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_docs_mensagens_apos_insert ON public.docs_mensagens;
CREATE TRIGGER trg_docs_mensagens_apos_insert
  AFTER INSERT ON public.docs_mensagens
  FOR EACH ROW EXECUTE FUNCTION public.docs_mensagem_apos_insert();

-- Mensagem é histórico: nunca some. "Apagar para todos" só carimba apagada_em.
-- Exceções (mesma régua de grupo_mensagens):
--   - service_role: o docs-acao remove a duplicata do eco de uma edição (única
--     remoção física, verificada lá: recente, 'externo', mesma conversa);
--   - CASCADE (depth > 1) do runbook de rollback. docs_conversas não tem grant
--     de DELETE para ninguém além do dono do banco.
CREATE OR REPLACE FUNCTION public.block_docs_mensagem_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user = 'service_role' OR pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'DELETE em docs_mensagens é restrito a service_role';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.block_docs_mensagem_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_docs_mensagens_block_delete ON public.docs_mensagens;
CREATE TRIGGER trg_docs_mensagens_block_delete
  BEFORE DELETE ON public.docs_mensagens
  FOR EACH ROW EXECUTE FUNCTION public.block_docs_mensagem_delete();

-- ————————————————————————————————————————————————————————————————
-- 7) RLS. Leitura: quem tem acesso ao Docs vê TUDO (decisão de produto).
--    Escrita: nenhuma pelo frontend — mensagens via Edge Functions
--    (service_role), conversa/eventos/leituras via RPC SECURITY DEFINER.
-- ————————————————————————————————————————————————————————————————
ALTER TABLE public.docs_conversas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.docs_mensagens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.docs_leituras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.docs_eventos ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.docs_conversas, public.docs_mensagens, public.docs_leituras,
  public.docs_eventos FROM anon, authenticated;
GRANT SELECT ON public.docs_conversas, public.docs_mensagens, public.docs_leituras,
  public.docs_eventos TO authenticated;

DROP POLICY IF EXISTS docs_conversas_select ON public.docs_conversas;
CREATE POLICY docs_conversas_select ON public.docs_conversas
  FOR SELECT TO authenticated
  USING (public.is_member_of(company_id) AND (SELECT public.pode_acessar_docs()));

DROP POLICY IF EXISTS docs_mensagens_select ON public.docs_mensagens;
CREATE POLICY docs_mensagens_select ON public.docs_mensagens
  FOR SELECT TO authenticated
  USING (public.is_member_of(company_id) AND (SELECT public.pode_acessar_docs()));

DROP POLICY IF EXISTS docs_eventos_select ON public.docs_eventos;
CREATE POLICY docs_eventos_select ON public.docs_eventos
  FOR SELECT TO authenticated
  USING (public.is_member_of(company_id) AND (SELECT public.pode_acessar_docs()));

DROP POLICY IF EXISTS docs_leituras_select ON public.docs_leituras;
CREATE POLICY docs_leituras_select ON public.docs_leituras
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND (SELECT public.pode_acessar_docs()));

-- Mídia do Docs mora em mensagens-midia/docs/<conversa_id>/…; as policies do
-- bucket só conhecem `mensagens` e `grupo_mensagens`.
--
-- A checagem mora numa função SECURITY DEFINER de propósito: dentro de uma
-- policy, o EXISTS em docs_mensagens passaria pela RLS da tabela linha a linha
-- (o `->>` não é leakproof) e nenhum índice ajudaria — 1,3 s por mídia com 300
-- mil mensagens. Pela função, o índice de storage_path resolve em ~1 ms.
CREATE OR REPLACE FUNCTION public.docs_midia_visivel(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.pode_acessar_docs() AND EXISTS (
    SELECT 1 FROM public.docs_mensagens dm
    WHERE (dm.media_metadata ->> 'storage_path') = p_name
      AND public.is_member_of(dm.company_id)
  )
$$;

REVOKE EXECUTE ON FUNCTION public.docs_midia_visivel(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.docs_midia_visivel(text) TO authenticated;

-- Criada só se ainda não existe: DROP POLICY em storage.objects pediria lock
-- exclusivo e enfileiraria todo o tráfego de mídia atrás da migration.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'docs_midia_select_acesso'
  ) THEN
    CREATE POLICY "docs_midia_select_acesso"
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (
        bucket_id = 'mensagens-midia'
        AND name LIKE 'docs/%'
        AND public.docs_midia_visivel(name)
      );
  END IF;
END $$;

-- ————————————————————————————————————————————————————————————————
-- 7b) A permissão `docs_acesso` só muda pela RPC docs_definir_acesso (admin).
--     As policies de user_permissions também aceitam `manage_permissions`;
--     estas RESTRICTIVE fecham essa porta só para esta flag. A RPC é SECURITY
--     DEFINER (dona da tabela), então não é afetada.
-- ————————————————————————————————————————————————————————————————
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_permissions'
      AND policyname = 'user_permissions_docs_acesso_so_rpc_ins'
  ) THEN
    CREATE POLICY user_permissions_docs_acesso_so_rpc_ins ON public.user_permissions
      AS RESTRICTIVE FOR INSERT TO authenticated
      WITH CHECK (permission <> 'docs_acesso');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_permissions'
      AND policyname = 'user_permissions_docs_acesso_so_rpc_del'
  ) THEN
    CREATE POLICY user_permissions_docs_acesso_so_rpc_del ON public.user_permissions
      AS RESTRICTIVE FOR DELETE TO authenticated
      USING (permission <> 'docs_acesso');
  END IF;
END $$;

-- Quem perde o acesso (flag removida, desligado, deixou de ser admin) solta as
-- conversas que estavam com ele: sem isso ficariam presas com um dono que nem
-- enxerga mais a aba, e o cliente de novo no vácuo.
CREATE OR REPLACE FUNCTION public.docs_soltar_conversas_sem_acesso(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL OR public.usuario_pode_acessar_docs(p_user_id) THEN
    RETURN;
  END IF;

  WITH soltas AS (
    UPDATE public.docs_conversas
      SET status = 'sem_dono', assigned_to = NULL, assigned_at = NULL
      WHERE assigned_to = p_user_id AND status = 'em_andamento'
      RETURNING id, company_id
  )
  INSERT INTO public.docs_eventos (company_id, conversa_id, tipo, actor_user_id, observacao)
  SELECT company_id, id, 'reaberta', auth.uid(), 'O dono perdeu o acesso ao Docs'
  FROM soltas;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.docs_soltar_conversas_sem_acesso(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_user_permissions_docs_soltar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.permission = 'docs_acesso' THEN
    PERFORM public.docs_soltar_conversas_sem_acesso(OLD.user_id);
  END IF;
  RETURN OLD;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_user_permissions_docs_soltar() FROM PUBLIC, anon, authenticated;

-- Gatilhos em tabelas que já existem: criados só se faltam (DROP TRIGGER pede
-- lock exclusivo em `users`, que toda tela lê o tempo todo).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_user_permissions_docs_soltar'
      AND tgrelid = 'public.user_permissions'::regclass
  ) THEN
    CREATE TRIGGER trg_user_permissions_docs_soltar
      AFTER DELETE ON public.user_permissions
      FOR EACH ROW EXECUTE FUNCTION public.trg_user_permissions_docs_soltar();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.trg_users_docs_soltar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.ativo IS DISTINCT FROM OLD.ativo
     OR NEW.is_superadmin IS DISTINCT FROM OLD.is_superadmin THEN
    PERFORM public.docs_soltar_conversas_sem_acesso(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_users_docs_soltar() FROM PUBLIC, anon, authenticated;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_users_docs_soltar' AND tgrelid = 'public.users'::regclass
  ) THEN
    CREATE TRIGGER trg_users_docs_soltar
      AFTER UPDATE OF ativo, is_superadmin ON public.users
      FOR EACH ROW EXECUTE FUNCTION public.trg_users_docs_soltar();
  END IF;
END $$;

-- ————————————————————————————————————————————————————————————————
-- 8) RPCs de ciclo da conversa.
--    Códigos de erro iguais aos da Inbox (RepassarModal já os entende):
--      42501 sem permissão · P0002 não encontrada · 23505 conflito ·
--      22023 parâmetro inválido.
-- ————————————————————————————————————————————————————————————————

-- Assumir: pega uma conversa sem dono / só envio / encerrada. Tomar a conversa
-- de OUTRA pessoa só o admin pode (espelha o "Atribuir a mim" da supervisão).
CREATE OR REPLACE FUNCTION public.docs_assumir(p_conversa_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_conv public.docs_conversas%ROWTYPE;
BEGIN
  IF v_me IS NULL OR NOT public.usuario_pode_acessar_docs(v_me) THEN
    RAISE EXCEPTION 'Sem acesso ao Docs' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_conv FROM public.docs_conversas WHERE id = p_conversa_id FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT public.is_member_of(v_conv.company_id) THEN
    RAISE EXCEPTION 'Conversa não encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF v_conv.status = 'em_andamento' THEN
    IF v_conv.assigned_to = v_me THEN
      RETURN;
    END IF;
    IF NOT public.current_user_is_superadmin() THEN
      RAISE EXCEPTION 'Conversa já está com outra pessoa' USING ERRCODE = '23505';
    END IF;
  END IF;

  UPDATE public.docs_conversas
    SET status = 'em_andamento',
        assigned_to = v_me,
        assigned_at = now(),
        closed_at = NULL,
        closed_by_user_id = NULL
    WHERE id = p_conversa_id;

  -- Admin tomando de outra pessoa: o evento guarda de quem era.
  INSERT INTO public.docs_eventos
    (company_id, conversa_id, tipo, actor_user_id, target_user_id, observacao)
  VALUES (
    v_conv.company_id, p_conversa_id, 'assumida', v_me, v_me,
    CASE WHEN v_conv.assigned_to IS NOT NULL
      THEN 'Tomada de ' || COALESCE(
        (SELECT nome FROM public.users WHERE id = v_conv.assigned_to), 'outra pessoa')
    END
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.docs_assumir(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.docs_assumir(uuid) TO authenticated;

-- Repassar: o dono (ou admin) entrega a conversa para outra pessoa COM acesso
-- ao Docs. Conversa sem dono: só admin distribui; colaborador assume antes.
CREATE OR REPLACE FUNCTION public.docs_repassar(
  p_conversa_id uuid,
  p_to_user_id uuid,
  p_observacao text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_conv public.docs_conversas%ROWTYPE;
  v_obs text := NULLIF(btrim(COALESCE(p_observacao, '')), '');
BEGIN
  IF v_me IS NULL OR NOT public.usuario_pode_acessar_docs(v_me) THEN
    RAISE EXCEPTION 'Sem acesso ao Docs' USING ERRCODE = '42501';
  END IF;
  IF p_to_user_id IS NULL THEN
    RAISE EXCEPTION 'Destino obrigatório' USING ERRCODE = '22023';
  END IF;
  IF v_obs IS NOT NULL AND char_length(v_obs) > 500 THEN
    RAISE EXCEPTION 'Observação longa demais' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_conv FROM public.docs_conversas WHERE id = p_conversa_id FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT public.is_member_of(v_conv.company_id) THEN
    RAISE EXCEPTION 'Conversa não encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.current_user_is_superadmin()
     AND NOT (v_conv.status = 'em_andamento' AND v_conv.assigned_to = v_me) THEN
    RAISE EXCEPTION 'Só o dono ou um admin pode repassar' USING ERRCODE = '42501';
  END IF;

  IF v_conv.assigned_to = p_to_user_id AND v_conv.status = 'em_andamento' THEN
    RAISE EXCEPTION 'A conversa já está com essa pessoa' USING ERRCODE = '23505';
  END IF;

  IF NOT public.usuario_pode_acessar_docs(p_to_user_id) THEN
    RAISE EXCEPTION 'Essa pessoa não tem acesso ao Docs' USING ERRCODE = '22023';
  END IF;

  UPDATE public.docs_conversas
    SET status = 'em_andamento',
        assigned_to = p_to_user_id,
        assigned_at = now(),
        closed_at = NULL,
        closed_by_user_id = NULL
    WHERE id = p_conversa_id;

  INSERT INTO public.docs_eventos
    (company_id, conversa_id, tipo, actor_user_id, target_user_id, observacao)
  VALUES (v_conv.company_id, p_conversa_id, 'repassada', v_me, p_to_user_id, v_obs);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.docs_repassar(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.docs_repassar(uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.docs_encerrar(p_conversa_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_conv public.docs_conversas%ROWTYPE;
BEGIN
  IF v_me IS NULL OR NOT public.usuario_pode_acessar_docs(v_me) THEN
    RAISE EXCEPTION 'Sem acesso ao Docs' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_conv FROM public.docs_conversas WHERE id = p_conversa_id FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT public.is_member_of(v_conv.company_id) THEN
    RAISE EXCEPTION 'Conversa não encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF v_conv.status = 'encerrada' THEN
    RETURN;
  END IF;

  IF NOT public.current_user_is_superadmin()
     AND NOT (v_conv.status = 'em_andamento' AND v_conv.assigned_to = v_me) THEN
    RAISE EXCEPTION 'Só o dono ou um admin pode encerrar' USING ERRCODE = '42501';
  END IF;

  UPDATE public.docs_conversas
    SET status = 'encerrada',
        assigned_to = NULL,
        assigned_at = NULL,
        closed_at = now(),
        closed_by_user_id = v_me
    WHERE id = p_conversa_id;

  INSERT INTO public.docs_eventos (company_id, conversa_id, tipo, actor_user_id)
  VALUES (v_conv.company_id, p_conversa_id, 'encerrada', v_me);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.docs_encerrar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.docs_encerrar(uuid) TO authenticated;

-- Nova conversa: abre (ou reabre) a conversa do cliente no número financeiro
-- já com quem chamou como dono. Devolve o id para a tela abrir o chat.
CREATE OR REPLACE FUNCTION public.docs_iniciar_conversa(p_client_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_company uuid;
  v_conv public.docs_conversas%ROWTYPE;
BEGIN
  IF v_me IS NULL OR NOT public.usuario_pode_acessar_docs(v_me) THEN
    RAISE EXCEPTION 'Sem acesso ao Docs' USING ERRCODE = '42501';
  END IF;

  SELECT company_id INTO v_company FROM public.clients WHERE id = p_client_id;
  IF v_company IS NULL OR NOT public.is_member_of(v_company) THEN
    RAISE EXCEPTION 'Contato não encontrado' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.docs_conversas (company_id, client_id, status)
  VALUES (v_company, p_client_id, 'so_envio')
  ON CONFLICT (company_id, client_id) DO NOTHING;

  SELECT * INTO v_conv
  FROM public.docs_conversas
  WHERE company_id = v_company AND client_id = p_client_id
  FOR NO KEY UPDATE;

  IF v_conv.status = 'em_andamento' THEN
    IF v_conv.assigned_to = v_me THEN
      RETURN v_conv.id;
    END IF;
    RAISE EXCEPTION 'Conversa já está com outra pessoa' USING ERRCODE = '23505';
  END IF;

  UPDATE public.docs_conversas
    SET status = 'em_andamento',
        assigned_to = v_me,
        assigned_at = now(),
        closed_at = NULL,
        closed_by_user_id = NULL
    WHERE id = v_conv.id;

  INSERT INTO public.docs_eventos (company_id, conversa_id, tipo, actor_user_id, target_user_id)
  VALUES (v_company, v_conv.id, 'iniciada', v_me, v_me);

  RETURN v_conv.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.docs_iniciar_conversa(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.docs_iniciar_conversa(uuid) TO authenticated;

-- ————————————————————————————————————————————————————————————————
-- 9) Não lidas. Mesma regra de grupos: conta INBOUND depois do maior entre
--    minha última leitura e a última OUTBOUND (alguém respondeu → endereçado).
--    O TOTAL do menu só soma o que é "da minha conta": sem dono (todo mundo
--    precisa ver) ou meu. A lista mostra o contador de todas.
-- ————————————————————————————————————————————————————————————————
CREATE OR REPLACE FUNCTION public.get_docs_unread_counts(p_conversa_ids uuid[])
RETURNS TABLE (conversa_id uuid, unread integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    c.id AS conversa_id,
    COALESCE(cnt.unread, 0)::integer AS unread
  FROM public.docs_conversas c
  LEFT JOIN public.docs_leituras rl
    ON rl.conversa_id = c.id AND rl.user_id = auth.uid()
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS unread
    FROM public.docs_mensagens m
    WHERE m.conversa_id = c.id
      AND m.direction = 'inbound'
      AND m.created_at > GREATEST(
        COALESCE(rl.last_read_at, '-infinity'::timestamptz),
        COALESCE(c.last_outbound_message_at, '-infinity'::timestamptz)
      )
  ) cnt ON true
  WHERE c.id = ANY(p_conversa_ids);
$$;

REVOKE EXECUTE ON FUNCTION public.get_docs_unread_counts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_docs_unread_counts(uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_docs_unread_total()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(cnt.unread), 0)::integer
  FROM public.docs_conversas c
  LEFT JOIN public.docs_leituras rl
    ON rl.conversa_id = c.id AND rl.user_id = auth.uid()
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS unread
    FROM public.docs_mensagens m
    WHERE m.conversa_id = c.id
      AND m.direction = 'inbound'
      AND m.created_at > GREATEST(
        COALESCE(rl.last_read_at, '-infinity'::timestamptz),
        COALESCE(c.last_outbound_message_at, '-infinity'::timestamptz)
      )
  ) cnt ON true
  WHERE (c.status = 'sem_dono' OR c.assigned_to = auth.uid());
$$;

REVOKE EXECUTE ON FUNCTION public.get_my_docs_unread_total() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_docs_unread_total() TO authenticated;

CREATE OR REPLACE FUNCTION public.marcar_docs_conversa_lida(p_conversa_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.pode_acessar_docs() THEN
    RETURN;
  END IF;

  SELECT company_id INTO v_company_id FROM public.docs_conversas WHERE id = p_conversa_id;
  IF v_company_id IS NULL OR NOT public.is_member_of(v_company_id) THEN
    RETURN;
  END IF;

  INSERT INTO public.docs_leituras (conversa_id, user_id, company_id, last_read_at)
  VALUES (p_conversa_id, auth.uid(), v_company_id, now())
  ON CONFLICT (conversa_id, user_id)
  DO UPDATE SET last_read_at = now();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.marcar_docs_conversa_lida(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_docs_conversa_lida(uuid) TO authenticated;

-- ————————————————————————————————————————————————————————————————
-- 10) Quem tem acesso (tela de Configurações e modal de Repassar).
-- ————————————————————————————————————————————————————————————————
CREATE OR REPLACE FUNCTION public.docs_listar_acesso()
RETURNS TABLE (
  user_id uuid,
  nome text,
  department_id uuid,
  department_nome text,
  is_superadmin boolean,
  tem_acesso boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    u.id,
    u.nome,
    u.department_id,
    d.nome,
    u.is_superadmin,
    public.usuario_pode_acessar_docs(u.id)
  FROM public.users u
  LEFT JOIN public.departments d ON d.id = u.department_id
  WHERE u.ativo = true
    AND COALESCE(u.is_system_user, false) = false
    AND public.pode_acessar_docs()
  ORDER BY u.nome;
$$;

REVOKE EXECUTE ON FUNCTION public.docs_listar_acesso() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.docs_listar_acesso() TO authenticated;

-- Liga/desliga o acesso de um colaborador. Só admin. A troca fica registrada
-- em config_audit_log pelo trg_audit_user_permissions que já existe.
CREATE OR REPLACE FUNCTION public.docs_definir_acesso(p_user_id uuid, p_permitir boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL OR NOT public.current_user_is_superadmin() THEN
    RAISE EXCEPTION 'Só admin configura o acesso ao Docs' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_permitir IS NULL THEN
    RAISE EXCEPTION 'Parâmetros obrigatórios' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user_id AND COALESCE(is_system_user, false) = false
  ) THEN
    RAISE EXCEPTION 'Colaborador não encontrado' USING ERRCODE = 'P0002';
  END IF;

  IF p_permitir THEN
    INSERT INTO public.user_permissions (user_id, permission, granted_by)
    VALUES (p_user_id, 'docs_acesso', v_me)
    ON CONFLICT (user_id, permission) DO NOTHING;
    RETURN;
  END IF;

  -- O gatilho trg_user_permissions_docs_soltar solta as conversas da pessoa
  -- (se ela não continuar com acesso por ser admin).
  DELETE FROM public.user_permissions
  WHERE user_id = p_user_id AND permission = 'docs_acesso';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.docs_definir_acesso(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.docs_definir_acesso(uuid, boolean) TO authenticated;

-- ————————————————————————————————————————————————————————————————
-- 11) Realtime — a aba Docs escuta conversas e mensagens. A RLS acima vale
--     também para o realtime: quem não tem acesso não recebe nada.
-- ————————————————————————————————————————————————————————————————
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'docs_conversas'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.docs_conversas';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'docs_mensagens'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.docs_mensagens';
  END IF;
END $$;
