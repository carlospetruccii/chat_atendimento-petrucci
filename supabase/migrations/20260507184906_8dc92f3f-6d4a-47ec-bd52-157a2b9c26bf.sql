
-- =====================================================
-- TABELA mensagens
-- =====================================================
CREATE TABLE public.mensagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  atendimento_id uuid NOT NULL REFERENCES public.atendimentos(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  department_id uuid REFERENCES public.departments(id) ON DELETE RESTRICT,
  direction public.direction_mensagem NOT NULL,
  sender_type public.sender_type NOT NULL,
  sent_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  tipo public.tipo_mensagem NOT NULL,
  content text,
  media_url text,
  media_metadata jsonb,
  zapi_message_id text,
  status_envio public.status_envio_mensagem NOT NULL DEFAULT 'aguardando_envio',
  status_whatsapp public.status_whatsapp_mensagem,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT mensagens_inbound_sender_chk CHECK (
    direction <> 'inbound' OR sender_type = 'cliente'
  ),
  CONSTRAINT mensagens_outbound_sender_chk CHECK (
    direction <> 'outbound' OR sender_type IN ('atendente','bot','sistema','externo')
  ),
  CONSTRAINT mensagens_sent_by_user_chk CHECK (
    (sender_type IN ('atendente','bot','sistema') AND sent_by_user_id IS NOT NULL)
    OR (sender_type IN ('cliente','externo') AND sent_by_user_id IS NULL)
  ),
  CONSTRAINT mensagens_texto_content_chk CHECK (
    tipo <> 'texto' OR content IS NOT NULL
  ),
  CONSTRAINT mensagens_media_url_chk CHECK (
    tipo IN ('texto','localizacao','contato') OR media_url IS NOT NULL
  )
);

-- Índice único parcial para idempotência Z-API
CREATE UNIQUE INDEX uniq_mensagens_zapi_message_id
  ON public.mensagens(zapi_message_id)
  WHERE zapi_message_id IS NOT NULL;

-- Índices de performance
CREATE INDEX idx_mensagens_atendimento_created
  ON public.mensagens(atendimento_id, created_at DESC);

CREATE INDEX idx_mensagens_client_dept_created
  ON public.mensagens(client_id, department_id, created_at DESC);

CREATE INDEX idx_mensagens_department_id
  ON public.mensagens(department_id) WHERE department_id IS NOT NULL;

-- =====================================================
-- RLS
-- =====================================================
ALTER TABLE public.mensagens ENABLE ROW LEVEL SECURITY;

CREATE POLICY mensagens_select_dept_or_admin ON public.mensagens
  FOR SELECT TO authenticated
  USING (
    public.current_user_can_view_all()
    OR department_id = public.current_user_department()
  );

CREATE POLICY mensagens_insert_self_outbound ON public.mensagens
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_is_superadmin()
    OR (
      direction = 'outbound'
      AND sender_type = 'atendente'
      AND sent_by_user_id = auth.uid()
    )
  );

CREATE POLICY mensagens_update_admin ON public.mensagens
  FOR UPDATE TO authenticated
  USING (public.current_user_is_superadmin())
  WITH CHECK (public.current_user_is_superadmin());

CREATE POLICY mensagens_delete_superadmin ON public.mensagens
  FOR DELETE TO authenticated
  USING (public.current_user_is_superadmin());

-- =====================================================
-- TRIGGERS
-- =====================================================

-- 1) Imutabilidade de department_id (NULL -> valor permitido; valor -> outro valor BLOQUEADO)
CREATE OR REPLACE FUNCTION public.protect_mensagem_department_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.department_id IS NOT NULL
     AND NEW.department_id IS DISTINCT FROM OLD.department_id THEN
    RAISE EXCEPTION 'department_id da mensagem é imutável após carimbo da triagem';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_mensagens_protect_department_id
  BEFORE UPDATE ON public.mensagens
  FOR EACH ROW EXECUTE FUNCTION public.protect_mensagem_department_id();

-- 2) Imutabilidade dos campos de identidade
CREATE OR REPLACE FUNCTION public.protect_mensagem_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.atendimento_id IS DISTINCT FROM OLD.atendimento_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.sender_type IS DISTINCT FROM OLD.sender_type
     OR NEW.sent_by_user_id IS DISTINCT FROM OLD.sent_by_user_id
     OR NEW.zapi_message_id IS DISTINCT FROM OLD.zapi_message_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Campos de identidade da mensagem são imutáveis após inserção';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_mensagens_protect_immutable
  BEFORE UPDATE ON public.mensagens
  FOR EACH ROW EXECUTE FUNCTION public.protect_mensagem_immutable_fields();

-- 3) Atualiza atendimentos.last_message_at
CREATE OR REPLACE FUNCTION public.update_atendimento_last_message_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.atendimentos
    SET last_message_at = NEW.created_at
    WHERE id = NEW.atendimento_id
      AND (last_message_at IS NULL OR last_message_at < NEW.created_at);
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_atendimento_last_message_at() FROM PUBLIC, anon;

CREATE TRIGGER trg_mensagens_update_last_message_at
  AFTER INSERT ON public.mensagens
  FOR EACH ROW EXECUTE FUNCTION public.update_atendimento_last_message_at();

-- 4) Bloqueio de DELETE exceto service_role ou superadmin
CREATE OR REPLACE FUNCTION public.block_mensagem_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user = 'service_role' THEN
    RETURN OLD;
  END IF;
  IF public.current_user_is_superadmin() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'DELETE em mensagens é restrito a service_role ou superadmin';
END;
$$;

CREATE TRIGGER trg_mensagens_block_delete
  BEFORE DELETE ON public.mensagens
  FOR EACH ROW EXECUTE FUNCTION public.block_mensagem_delete();
