-- Ajustes de acompanhamento da feature de grupos, vindos da revisão de segurança.
--
-- Rollback (runbook, caso precise desfazer a feature inteira):
--   DROP POLICY IF EXISTS "grupo_midia_select_membro" ON storage.objects;
--   DROP TABLE IF EXISTS public.grupo_leituras, public.grupo_mensagens, public.grupos;
--   DROP TYPE IF EXISTS public.grupo_sender_type;

-- ————————————————————————————————————————————————————————————————
-- 1) Policy de Storage para a mídia de grupo.
--
-- BUG REAL que isso corrige: a única policy de SELECT do bucket
-- (`mensagens_midia_select_visivel`) exige que o objeto seja referenciado por
-- alguma linha de `mensagens`. Mídia de grupo é referenciada por
-- `grupo_mensagens`, que a policy não conhece — então TODA imagem, áudio, vídeo
-- e documento de grupo apareceria como "Mídia indisponível" na tela.
--
-- Diferente da policy antiga, esta é `TO authenticated` (não `public`): não há
-- motivo para o papel `anon` conseguir assinar mídia de grupo.
-- ————————————————————————————————————————————————————————————————
DROP POLICY IF EXISTS "grupo_midia_select_membro" ON storage.objects;

CREATE POLICY "grupo_midia_select_membro"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'mensagens-midia'
    AND EXISTS (
      SELECT 1 FROM public.grupo_mensagens gm
      WHERE (gm.media_metadata ->> 'storage_path') = objects.name
        AND public.is_member_of(gm.company_id)
    )
  );

-- ————————————————————————————————————————————————————————————————
-- 2) Citação amarrada ao MESMO grupo.
--
-- A FK de `reply_to_message_id` era só por id, então uma linha podia citar
-- mensagem de OUTRO grupo (e, em multi-empresa, de outra empresa) e o `replyid`
-- enviado ao WhatsApp apontaria para outra conversa. A Edge Function já valida
-- isso, mas a garantia tem que estar no banco: é a mesma técnica composta usada
-- em `grupo_mensagens_grupo_same_company_fk`.
-- ————————————————————————————————————————————————————————————————
ALTER TABLE public.grupo_mensagens
  DROP CONSTRAINT IF EXISTS grupo_mensagens_id_grupo_key;
ALTER TABLE public.grupo_mensagens
  ADD CONSTRAINT grupo_mensagens_id_grupo_key UNIQUE (id, grupo_id);

ALTER TABLE public.grupo_mensagens
  DROP CONSTRAINT IF EXISTS grupo_mensagens_reply_to_message_id_fkey;
ALTER TABLE public.grupo_mensagens
  DROP CONSTRAINT IF EXISTS grupo_mensagens_reply_same_grupo_fk;
ALTER TABLE public.grupo_mensagens
  ADD CONSTRAINT grupo_mensagens_reply_same_grupo_fk
  FOREIGN KEY (reply_to_message_id, grupo_id)
  REFERENCES public.grupo_mensagens(id, grupo_id)
  ON DELETE SET NULL;

-- Índice de cobertura da FK composta (o antigo era só reply_to_message_id).
DROP INDEX IF EXISTS public.idx_grupo_mensagens_reply_to;
CREATE INDEX IF NOT EXISTS idx_grupo_mensagens_reply_grupo
  ON public.grupo_mensagens (reply_to_message_id, grupo_id);

-- ————————————————————————————————————————————————————————————————
-- 3) `grupo_leituras.company_id` era ON DELETE RESTRICT enquanto `grupo_id` era
--    CASCADE — apagar uma empresa falharia por causa dessas linhas. Alinha.
-- ————————————————————————————————————————————————————————————————
ALTER TABLE public.grupo_leituras
  DROP CONSTRAINT IF EXISTS grupo_leituras_company_id_fkey;
ALTER TABLE public.grupo_leituras
  ADD CONSTRAINT grupo_leituras_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
