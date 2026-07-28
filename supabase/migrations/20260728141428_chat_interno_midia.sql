-- ============================================================================
-- Mídia no chat interno da equipe: imagem, vídeo, documento e áudio.
--
-- Diferença central em relação a grupo/atendimento: não há uazapi. Lá o arquivo
-- vai para a Edge Function, que fala com o WhatsApp e só depois grava no bucket.
-- Aqui o destino é só o nosso Storage, então o cliente sobe DIRETO para
-- `mensagens-midia` e depois registra a mensagem via RPC. Isso evita uma Edge
-- Function inteira só para repassar bytes.
--
-- O que trava o caminho direto (as três coisas juntas):
--   1) policy de INSERT no Storage só aceita `internas/<conversa_id>/...` de
--      quem participa da conversa;
--   2) a RPC recusa storage_path que não comece com `internas/<conversa_id>/`,
--      então ninguém referencia mídia de outra conversa para ganhar leitura;
--   3) policy de SELECT só libera objeto referenciado por mensagem de conversa
--      da qual você participa.
--
-- Upload primeiro, registro depois: se a RPC falhar, sobra um objeto órfão no
-- bucket. Órfão é inofensivo — sem linha em `mensagens_internas` apontando para
-- ele, a policy de SELECT não deixa ninguém ler. A ordem inversa (registrar e
-- depois subir) deixaria a bolha na tela apontando para arquivo inexistente,
-- que é pior de ver.
-- ============================================================================

-- ————————————————————————————————————————————————————————————————
-- 1) Colunas de mídia. Reaproveita o enum `tipo_mensagem` do resto do produto.
-- ————————————————————————————————————————————————————————————————
ALTER TABLE public.mensagens_internas
  ADD COLUMN IF NOT EXISTS tipo public.tipo_mensagem NOT NULL DEFAULT 'texto',
  ADD COLUMN IF NOT EXISTS media_metadata jsonb;

-- `content` deixa de ser obrigatório: imagem sem legenda não tem texto.
ALTER TABLE public.mensagens_internas ALTER COLUMN content DROP NOT NULL;

ALTER TABLE public.mensagens_internas
  DROP CONSTRAINT IF EXISTS mensagens_internas_content_chk;
ALTER TABLE public.mensagens_internas
  ADD CONSTRAINT mensagens_internas_content_chk CHECK (
    CASE
      WHEN tipo = 'texto'
        THEN content IS NOT NULL AND char_length(btrim(content)) BETWEEN 1 AND 4000
      ELSE content IS NULL OR char_length(content) <= 4000
    END
  );

-- Conversa interna suporta menos tipos que o WhatsApp: não existe figurinha,
-- localização nem cartão de contato aqui.
ALTER TABLE public.mensagens_internas
  DROP CONSTRAINT IF EXISTS mensagens_internas_tipo_suportado_chk;
ALTER TABLE public.mensagens_internas
  ADD CONSTRAINT mensagens_internas_tipo_suportado_chk CHECK (
    tipo IN ('texto', 'imagem', 'audio', 'video', 'documento')
  );

-- Mídia sem arquivo no bucket não renderiza: exige o storage_path.
ALTER TABLE public.mensagens_internas
  DROP CONSTRAINT IF EXISTS mensagens_internas_midia_chk;
ALTER TABLE public.mensagens_internas
  ADD CONSTRAINT mensagens_internas_midia_chk CHECK (
    tipo = 'texto' OR (media_metadata ->> 'storage_path') IS NOT NULL
  );

-- ————————————————————————————————————————————————————————————————
-- 2) Quem pode escrever mídia numa pasta de conversa.
--    Em plpgsql (e não inline na policy) porque o segundo segmento do path é
--    texto vindo do cliente: `::uuid` direto estouraria exceção em vez de
--    simplesmente negar o upload.
-- ————————————————————————————————————————————————————————————————
CREATE OR REPLACE FUNCTION public.pode_escrever_midia_interna(p_object_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conversa uuid;
BEGIN
  IF split_part(p_object_name, '/', 1) <> 'internas' THEN
    RETURN false;
  END IF;
  -- Precisa ter nome de arquivo depois da pasta da conversa.
  IF split_part(p_object_name, '/', 3) = '' THEN
    RETURN false;
  END IF;

  BEGIN
    v_conversa := split_part(p_object_name, '/', 2)::uuid;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;

  RETURN EXISTS (
    SELECT 1 FROM public.conversas_internas c
    WHERE c.id = v_conversa
      AND auth.uid() IN (c.user_a_id, c.user_b_id)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.pode_escrever_midia_interna(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pode_escrever_midia_interna(text) TO authenticated;

-- ————————————————————————————————————————————————————————————————
-- 3) Policies de Storage.
--
-- INSERT é a primeira do bucket: até aqui todo upload passava por Edge Function
-- (service_role, que ignora RLS). Fica restrita à pasta da própria conversa.
--
-- SELECT NÃO usa is_member_of() — a policy de grupo usa, mas conversa interna é
-- privada: só os dois participantes leem a mídia, nem admin.
-- ————————————————————————————————————————————————————————————————
DROP POLICY IF EXISTS "interna_midia_insert_participante" ON storage.objects;
CREATE POLICY "interna_midia_insert_participante"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'mensagens-midia'
    AND public.pode_escrever_midia_interna(name)
  );

DROP POLICY IF EXISTS "interna_midia_select_participante" ON storage.objects;
CREATE POLICY "interna_midia_select_participante"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'mensagens-midia'
    AND EXISTS (
      SELECT 1
      FROM public.mensagens_internas mi
      JOIN public.conversas_internas c ON c.id = mi.conversa_id
      WHERE (mi.media_metadata ->> 'storage_path') = objects.name
        AND auth.uid() IN (c.user_a_id, c.user_b_id)
    )
  );

-- ————————————————————————————————————————————————————————————————
-- 4) RPC de envio de mídia. O metadata é montado AQUI, campo por campo: aceitar
--    jsonb do cliente deixaria ele escrever storage_path arbitrário (e assim
--    ganhar leitura de mídia alheia pela policy de SELECT).
-- ————————————————————————————————————————————————————————————————
CREATE OR REPLACE FUNCTION public.enviar_midia_interna(
  p_conversa_id uuid,
  p_tipo text,
  p_storage_path text,
  p_content text DEFAULT NULL,
  p_file_name text DEFAULT NULL,
  p_tamanho_bytes bigint DEFAULT NULL,
  p_duracao_seg integer DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eu uuid := auth.uid();
  v_company_id uuid;
  v_content text := NULLIF(btrim(COALESCE(p_content, '')), '');
  v_prefixo text;
  v_id uuid;
BEGIN
  IF v_eu IS NULL THEN
    RAISE EXCEPTION 'nao_autenticado';
  END IF;

  IF p_tipo NOT IN ('imagem', 'audio', 'video', 'documento') THEN
    RAISE EXCEPTION 'tipo_invalido';
  END IF;

  IF v_content IS NOT NULL AND char_length(v_content) > 4000 THEN
    RAISE EXCEPTION 'mensagem_muito_longa';
  END IF;

  -- Ser participante é a única autorização de envio.
  SELECT c.company_id INTO v_company_id
  FROM public.conversas_internas c
  WHERE c.id = p_conversa_id AND v_eu IN (c.user_a_id, c.user_b_id);

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  -- Trava o arquivo na pasta desta conversa: sem isso daria para registrar
  -- mídia de outra conversa e passar a poder lê-la.
  v_prefixo := 'internas/' || p_conversa_id::text || '/';
  IF p_storage_path IS NULL OR left(p_storage_path, char_length(v_prefixo)) <> v_prefixo THEN
    RAISE EXCEPTION 'storage_path_invalido';
  END IF;

  INSERT INTO public.mensagens_internas (
    company_id, conversa_id, sender_user_id, tipo, content, media_metadata
  )
  VALUES (
    v_company_id,
    p_conversa_id,
    v_eu,
    p_tipo::public.tipo_mensagem,
    v_content,
    jsonb_strip_nulls(jsonb_build_object(
      'storage_path', p_storage_path,
      'file_name', p_file_name,
      'tamanho_bytes', p_tamanho_bytes,
      'duracao_seg', p_duracao_seg
    ))
  )
  RETURNING id INTO v_id;

  -- Quem enviou já leu.
  INSERT INTO public.conversa_interna_leituras (conversa_id, user_id, company_id, last_read_at)
  VALUES (p_conversa_id, v_eu, v_company_id, now())
  ON CONFLICT (conversa_id, user_id) DO UPDATE SET last_read_at = now();

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enviar_midia_interna(uuid, text, text, text, text, bigint, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enviar_midia_interna(uuid, text, text, text, text, bigint, integer)
  TO authenticated;

-- ————————————————————————————————————————————————————————————————
-- 5) A lista precisa do TIPO da última mensagem: mídia sem legenda tem content
--    NULL, e sem o tipo o preview ficaria vazio em vez de "📷 Imagem".
-- ————————————————————————————————————————————————————————————————
DROP FUNCTION IF EXISTS public.listar_conversas_internas();
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
  last_message_tipo text,
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
    ult.tipo::text AS last_message_tipo,
    (ult.sender_user_id = auth.uid()) AS last_message_de_mim,
    COALESCE(cnt.unread, 0)::integer AS unread
  FROM public.conversas_internas c
  JOIN public.users o
    ON o.id = CASE WHEN c.user_a_id = auth.uid() THEN c.user_b_id ELSE c.user_a_id END
  LEFT JOIN public.departments d ON d.id = o.department_id
  LEFT JOIN public.conversa_interna_leituras rl
    ON rl.conversa_id = c.id AND rl.user_id = auth.uid()
  LEFT JOIN LATERAL (
    SELECT m.content, m.sender_user_id, m.tipo
    FROM public.mensagens_internas m
    WHERE m.conversa_id = c.id
    ORDER BY m.created_at DESC, m.id DESC
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

COMMENT ON TABLE public.mensagens_internas IS
  'Mensagens do chat interno (texto e mídia, append-only). Escrita só via RPC enviar_mensagem_interna / enviar_midia_interna, que fixam o autor em auth.uid(). Mídia mora em mensagens-midia sob internas/<conversa_id>/.';
