-- ============================================================================
-- Chat interno da equipe ("Equipe" no Inbox) — conversa 1:1 entre colaboradores,
-- inteiramente DENTRO do sistema. Nada disso passa pelo WhatsApp.
--
-- Por que tabelas próprias (e não `atendimentos`/`mensagens` nem `grupos`):
--   1. `atendimentos`/`mensagens` exigem `client_id` NOT NULL apontando para
--      `clients` (CHECK de E.164). Um colega não é um cliente e não tem número
--      obrigatório.
--   2. Conversa interna NÃO tem triagem, bot, departamento, atribuição,
--      encerramento, envio para a uazapi nem status de entrega no WhatsApp.
--      Se morasse em `atendimentos`, todo cron (encerramento automático, alerta
--      de parado, reativação de bot) e `vw_pendentes` precisariam de um filtro
--      novo — e um filtro esquecido = bot respondendo colega.
--   3. `grupos` é indexado por `wa_jid` (CHECK '...@g.us'): não existe JID para
--      uma conversa que nunca toca o WhatsApp.
--
-- Privacidade: DM é privada de verdade. As policies NÃO usam `is_member_of()`
-- (que hoje devolve true para todo mundo por causa de `auth_enforcement_enabled
-- = false`) — elas checam participação direta via `auth.uid()`. Assim a conversa
-- da Silmara com a Andreza não é legível por terceiros nem hoje nem depois.
--
-- Escrita: nenhuma policy de INSERT/UPDATE/DELETE. Todo write passa por RPC
-- SECURITY DEFINER que fixa o autor em `auth.uid()`, então não há caminho para
-- forjar autoria a partir do cliente (mesma regra do `grupo-enviar`).
-- ============================================================================

-- ————————————————————————————————————————————————————————————————
-- 1) conversas_internas — a "thread" entre DUAS pessoas.
--
--    O par é normalizado (`user_a_id < user_b_id`) e único: isso torna
--    impossível, por construção, existirem duas conversas entre as mesmas duas
--    pessoas. Não há tabela de participantes porque não há conversa interna de
--    grupo — quando (e se) houver, ela nasce como estrutura separada em vez de
--    afrouxar esta.
-- ————————————————————————————————————————————————————————————————
CREATE TABLE IF NOT EXISTS public.conversas_internas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT '11111111-1111-1111-1111-111111111111'::uuid
    REFERENCES public.companies(id) ON DELETE CASCADE,
  user_a_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  user_b_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversas_internas_par_ordenado_chk CHECK (user_a_id < user_b_id),
  CONSTRAINT conversas_internas_par_key UNIQUE (user_a_id, user_b_id),
  -- Alvo da FK composta de mensagens/leituras: amarra a linha filha à MESMA
  -- empresa da conversa.
  CONSTRAINT conversas_internas_id_company_key UNIQUE (id, company_id)
);

-- Ordenação da lista ("quem falou comigo mais recentemente"), por participante.
CREATE INDEX IF NOT EXISTS idx_conversas_internas_user_a
  ON public.conversas_internas (user_a_id, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_conversas_internas_user_b
  ON public.conversas_internas (user_b_id, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_conversas_internas_company_id
  ON public.conversas_internas (company_id);

-- ————————————————————————————————————————————————————————————————
-- 2) mensagens_internas — texto puro, sem mídia.
--    Sem `direction`: em conversa interna quem é "entrada" e quem é "saída"
--    depende de quem está olhando. O que existe é `sender_user_id`, e a UI
--    compara com o usuário logado.
-- ————————————————————————————————————————————————————————————————
CREATE TABLE IF NOT EXISTS public.mensagens_internas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT '11111111-1111-1111-1111-111111111111'::uuid
    REFERENCES public.companies(id) ON DELETE CASCADE,
  conversa_id uuid NOT NULL REFERENCES public.conversas_internas(id) ON DELETE CASCADE,
  sender_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mensagens_internas_content_chk
    CHECK (char_length(btrim(content)) BETWEEN 1 AND 4000),
  CONSTRAINT mensagens_internas_conversa_same_company_fk
    FOREIGN KEY (conversa_id, company_id)
    REFERENCES public.conversas_internas(id, company_id)
);

-- Paginação do chat (mais recentes primeiro) — mesma estratégia de grupo.
CREATE INDEX IF NOT EXISTS idx_mensagens_internas_conversa_created_at
  ON public.mensagens_internas (conversa_id, created_at DESC);

-- Cauda não lida: "mensagens desta conversa que não são minhas".
CREATE INDEX IF NOT EXISTS idx_mensagens_internas_conversa_sender_created_at
  ON public.mensagens_internas (conversa_id, sender_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_mensagens_internas_company_id
  ON public.mensagens_internas (company_id);

-- ————————————————————————————————————————————————————————————————
-- 3) conversa_interna_leituras — estado de leitura por usuário (badge).
--    Mesmo desenho de grupo_leituras: escrita só via RPC SECURITY DEFINER que
--    fixa user_id = auth.uid(), então não existe policy de escrita.
-- ————————————————————————————————————————————————————————————————
CREATE TABLE IF NOT EXISTS public.conversa_interna_leituras (
  conversa_id uuid NOT NULL REFERENCES public.conversas_internas(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversa_id, user_id),
  CONSTRAINT conversa_interna_leituras_conversa_same_company_fk
    FOREIGN KEY (conversa_id, company_id)
    REFERENCES public.conversas_internas(id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_conversa_interna_leituras_user_id
  ON public.conversa_interna_leituras (user_id);

-- ————————————————————————————————————————————————————————————————
-- 4) Carimbo de última mensagem — GREATEST para não retroceder.
-- ————————————————————————————————————————————————————————————————
CREATE OR REPLACE FUNCTION public.update_conversa_interna_last_message_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.conversas_internas
    SET last_message_at = GREATEST(last_message_at, NEW.created_at)
    WHERE id = NEW.conversa_id
      AND (last_message_at IS NULL OR last_message_at < NEW.created_at);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mensagens_internas_last_message_at ON public.mensagens_internas;
CREATE TRIGGER trg_mensagens_internas_last_message_at
  AFTER INSERT ON public.mensagens_internas
  FOR EACH ROW EXECUTE FUNCTION public.update_conversa_interna_last_message_at();

-- ————————————————————————————————————————————————————————————————
-- 5) Mensagem interna é definitiva: não há editar nem apagar na UI, e o banco
--    reflete isso. Deixar a porta aberta convidaria a "corrigir" histórico de
--    conversa alheia via API.
-- ————————————————————————————————————————————————————————————————
CREATE OR REPLACE FUNCTION public.block_mensagem_interna_update_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user = 'service_role' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'mensagens_internas é somente-inserção (UPDATE/DELETE restrito a service_role)';
END;
$$;

DROP TRIGGER IF EXISTS trg_mensagens_internas_block_update ON public.mensagens_internas;
CREATE TRIGGER trg_mensagens_internas_block_update
  BEFORE UPDATE ON public.mensagens_internas
  FOR EACH ROW EXECUTE FUNCTION public.block_mensagem_interna_update_delete();

DROP TRIGGER IF EXISTS trg_mensagens_internas_block_delete ON public.mensagens_internas;
CREATE TRIGGER trg_mensagens_internas_block_delete
  BEFORE DELETE ON public.mensagens_internas
  FOR EACH ROW EXECUTE FUNCTION public.block_mensagem_interna_update_delete();

-- ————————————————————————————————————————————————————————————————
-- 6) RLS — só os DOIS participantes leem. Nem superadmin: DM entre
--    colaboradores não é canal de atendimento, é conversa particular de
--    trabalho. Supervisão de atendimento continua sendo a tela de Supervisão.
-- ————————————————————————————————————————————————————————————————
ALTER TABLE public.conversas_internas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mensagens_internas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversa_interna_leituras ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversas_internas_select ON public.conversas_internas;
CREATE POLICY conversas_internas_select ON public.conversas_internas
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) IN (user_a_id, user_b_id));

DROP POLICY IF EXISTS mensagens_internas_select ON public.mensagens_internas;
CREATE POLICY mensagens_internas_select ON public.mensagens_internas
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.conversas_internas c
    WHERE c.id = mensagens_internas.conversa_id
      AND (SELECT auth.uid()) IN (c.user_a_id, c.user_b_id)
  ));

DROP POLICY IF EXISTS conversa_interna_leituras_select ON public.conversa_interna_leituras;
CREATE POLICY conversa_interna_leituras_select ON public.conversa_interna_leituras
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- ————————————————————————————————————————————————————————————————
-- 7) RPCs
-- ————————————————————————————————————————————————————————————————

-- Quem pode conversar: pessoa ativa, real (não Bot/Sistema) e membro ativo da
-- mesma empresa. Uma função só para a regra não divergir entre abrir conversa,
-- enviar mensagem e listar colegas.
CREATE OR REPLACE FUNCTION public.pode_conversar_internamente(p_user_id uuid, p_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.company_members cm ON cm.user_id = u.id
    WHERE u.id = p_user_id
      AND u.ativo = true
      AND u.is_system_user = false
      AND cm.company_id = p_company_id
      AND cm.ativo = true
  );
$$;

REVOKE EXECUTE ON FUNCTION public.pode_conversar_internamente(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pode_conversar_internamente(uuid, uuid) TO authenticated;

-- Abre (ou reaproveita) a conversa com um colega. Idempotente: chamar duas
-- vezes devolve o mesmo id, garantido pela UNIQUE do par normalizado.
CREATE OR REPLACE FUNCTION public.abrir_conversa_interna(p_outro_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eu uuid := auth.uid();
  v_company_id uuid;
  v_a uuid;
  v_b uuid;
  v_id uuid;
BEGIN
  IF v_eu IS NULL THEN
    RAISE EXCEPTION 'nao_autenticado';
  END IF;
  IF p_outro_user_id IS NULL OR p_outro_user_id = v_eu THEN
    RAISE EXCEPTION 'destinatario_invalido';
  END IF;

  SELECT cm.company_id INTO v_company_id
  FROM public.company_members cm
  WHERE cm.user_id = v_eu AND cm.ativo = true
  LIMIT 1;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'sem_empresa';
  END IF;

  IF NOT public.pode_conversar_internamente(p_outro_user_id, v_company_id) THEN
    RAISE EXCEPTION 'destinatario_invalido';
  END IF;

  -- Normaliza o par para casar com a UNIQUE (user_a_id < user_b_id).
  v_a := LEAST(v_eu, p_outro_user_id);
  v_b := GREATEST(v_eu, p_outro_user_id);

  INSERT INTO public.conversas_internas (company_id, user_a_id, user_b_id)
  VALUES (v_company_id, v_a, v_b)
  ON CONFLICT (user_a_id, user_b_id) DO NOTHING
  RETURNING id INTO v_id;

  -- ON CONFLICT DO NOTHING não devolve linha: a conversa já existia.
  IF v_id IS NULL THEN
    SELECT id INTO v_id
    FROM public.conversas_internas
    WHERE user_a_id = v_a AND user_b_id = v_b;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.abrir_conversa_interna(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.abrir_conversa_interna(uuid) TO authenticated;

-- Envia mensagem. O autor vem do JWT, nunca do corpo da chamada.
CREATE OR REPLACE FUNCTION public.enviar_mensagem_interna(p_conversa_id uuid, p_content text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eu uuid := auth.uid();
  v_company_id uuid;
  v_content text := btrim(COALESCE(p_content, ''));
  v_id uuid;
BEGIN
  IF v_eu IS NULL THEN
    RAISE EXCEPTION 'nao_autenticado';
  END IF;
  IF v_content = '' THEN
    RAISE EXCEPTION 'mensagem_vazia';
  END IF;
  IF char_length(v_content) > 4000 THEN
    RAISE EXCEPTION 'mensagem_muito_longa';
  END IF;

  -- Ser participante é a única autorização de envio.
  SELECT c.company_id INTO v_company_id
  FROM public.conversas_internas c
  WHERE c.id = p_conversa_id AND v_eu IN (c.user_a_id, c.user_b_id);

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  INSERT INTO public.mensagens_internas (company_id, conversa_id, sender_user_id, content)
  VALUES (v_company_id, p_conversa_id, v_eu, v_content)
  RETURNING id INTO v_id;

  -- Quem escreveu já leu: evita a própria mensagem contar como não lida.
  INSERT INTO public.conversa_interna_leituras (conversa_id, user_id, company_id, last_read_at)
  VALUES (p_conversa_id, v_eu, v_company_id, now())
  ON CONFLICT (conversa_id, user_id) DO UPDATE SET last_read_at = now();

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enviar_mensagem_interna(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enviar_mensagem_interna(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.marcar_conversa_interna_lida(p_conversa_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eu uuid := auth.uid();
  v_company_id uuid;
BEGIN
  IF v_eu IS NULL THEN
    RETURN;
  END IF;

  SELECT c.company_id INTO v_company_id
  FROM public.conversas_internas c
  WHERE c.id = p_conversa_id AND v_eu IN (c.user_a_id, c.user_b_id);

  IF v_company_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.conversa_interna_leituras (conversa_id, user_id, company_id, last_read_at)
  VALUES (p_conversa_id, v_eu, v_company_id, now())
  ON CONFLICT (conversa_id, user_id) DO UPDATE SET last_read_at = now();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.marcar_conversa_interna_lida(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_conversa_interna_lida(uuid) TO authenticated;

-- Lista da aba Equipe: conversa + o OUTRO participante + preview + não lidas,
-- numa ida só (a alternativa era 1 query da lista + N do preview + N do
-- contador).
CREATE OR REPLACE FUNCTION public.listar_conversas_internas()
RETURNS TABLE (
  conversa_id uuid,
  outro_user_id uuid,
  outro_nome text,
  outro_department_nome text,
  outro_department_cor text,
  outro_disponivel boolean,
  last_message_at timestamptz,
  last_message_content text,
  last_message_de_mim boolean,
  unread integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    c.id AS conversa_id,
    o.id AS outro_user_id,
    o.nome AS outro_nome,
    d.nome AS outro_department_nome,
    d.cor AS outro_department_cor,
    o.disponivel AS outro_disponivel,
    c.last_message_at,
    ult.content AS last_message_content,
    (ult.sender_user_id = auth.uid()) AS last_message_de_mim,
    COALESCE(cnt.unread, 0)::integer AS unread
  FROM public.conversas_internas c
  JOIN public.users o
    ON o.id = CASE WHEN c.user_a_id = auth.uid() THEN c.user_b_id ELSE c.user_a_id END
  LEFT JOIN public.departments d ON d.id = o.department_id
  LEFT JOIN public.conversa_interna_leituras rl
    ON rl.conversa_id = c.id AND rl.user_id = auth.uid()
  LEFT JOIN LATERAL (
    SELECT m.content, m.sender_user_id
    FROM public.mensagens_internas m
    WHERE m.conversa_id = c.id
    ORDER BY m.created_at DESC
    LIMIT 1
  ) ult ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS unread
    FROM public.mensagens_internas m
    WHERE m.conversa_id = c.id
      AND m.sender_user_id <> auth.uid()
      AND m.created_at > COALESCE(rl.last_read_at, '-infinity'::timestamptz)
  ) cnt ON true
  WHERE auth.uid() IN (c.user_a_id, c.user_b_id)
  ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.listar_conversas_internas() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_conversas_internas() TO authenticated;

-- Badge do Inbox e da aba Equipe.
CREATE OR REPLACE FUNCTION public.get_my_internas_unread_total()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(cnt.unread), 0)::integer
  FROM public.conversas_internas c
  LEFT JOIN public.conversa_interna_leituras rl
    ON rl.conversa_id = c.id AND rl.user_id = auth.uid()
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS unread
    FROM public.mensagens_internas m
    WHERE m.conversa_id = c.id
      AND m.sender_user_id <> auth.uid()
      AND m.created_at > COALESCE(rl.last_read_at, '-infinity'::timestamptz)
  ) cnt ON true
  WHERE auth.uid() IN (c.user_a_id, c.user_b_id);
$$;

REVOKE EXECUTE ON FUNCTION public.get_my_internas_unread_total() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_internas_unread_total() TO authenticated;

-- Colegas disponíveis para iniciar conversa (exclui eu, Bot/Sistema e inativos).
CREATE OR REPLACE FUNCTION public.listar_colegas_internos()
RETURNS TABLE (
  user_id uuid,
  nome text,
  department_nome text,
  department_cor text,
  disponivel boolean,
  conversa_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    u.id AS user_id,
    u.nome,
    d.nome AS department_nome,
    d.cor AS department_cor,
    u.disponivel,
    c.id AS conversa_id
  FROM public.users u
  JOIN public.company_members cm ON cm.user_id = u.id AND cm.ativo = true
  LEFT JOIN public.departments d ON d.id = u.department_id
  LEFT JOIN public.conversas_internas c
    ON c.user_a_id = LEAST(u.id, auth.uid())
   AND c.user_b_id = GREATEST(u.id, auth.uid())
  WHERE u.ativo = true
    AND u.is_system_user = false
    AND u.id <> auth.uid()
    AND cm.company_id IN (
      SELECT company_id FROM public.company_members
      WHERE user_id = auth.uid() AND ativo = true
    )
  ORDER BY u.nome;
$$;

REVOKE EXECUTE ON FUNCTION public.listar_colegas_internos() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_colegas_internos() TO authenticated;

-- ————————————————————————————————————————————————————————————————
-- 8) Realtime — a aba Equipe escuta INSERT para atualizar lista e chat aberto.
--    Com RLS ligada, o Realtime só entrega a linha a quem a policy autoriza:
--    o par da conversa. Ninguém mais recebe o evento.
-- ————————————————————————————————————————————————————————————————
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public' AND tablename = 'mensagens_internas'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.mensagens_internas';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public' AND tablename = 'conversas_internas'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.conversas_internas';
  END IF;
END $$;

COMMENT ON TABLE public.conversas_internas IS
  'Chat interno da equipe: thread 1:1 entre dois colaboradores. Par normalizado (user_a_id < user_b_id) e único. Não passa pelo WhatsApp.';
COMMENT ON TABLE public.mensagens_internas IS
  'Mensagens do chat interno (texto puro, append-only). Escrita só via RPC enviar_mensagem_interna, que fixa o autor em auth.uid().';
COMMENT ON TABLE public.conversa_interna_leituras IS
  'Estado de leitura do chat interno por usuário (badge de não lidas). Escrita só via RPC marcar_conversa_interna_lida.';
