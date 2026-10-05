-- ============================================================================
-- Aba Docs: resposta automática no número financeiro.
--
-- O número financeiro só dispara documentos e ninguém o acompanha em tempo real.
-- Quando o cliente escreve nele, o sistema avisa (pelo próprio número) que ali
-- é só envio de documentos e passa o número do atendimento. No máximo 1 aviso a
-- cada 3h por cliente (decisão do João, 30/09/2026) e nunca enquanto a conversa
-- tem dono (alguém já está atendendo).
--
-- - Texto: template `docs_aviso_somente_documentos` em templates_mensagem
--   (editável na aba Templates e em Configurações → Docs). `ativo` é o
--   liga/desliga.
-- - Trava das 3h: `docs_conversas.ultimo_aviso_automatico_at`, reservada por
--   UPDATE condicional (atômico) — várias mensagens chegando juntas geram um
--   aviso só.
--
-- Rollback:
--   ALTER TABLE public.docs_conversas DROP COLUMN IF EXISTS ultimo_aviso_automatico_at;
--   DELETE FROM public.templates_mensagem WHERE chave = 'docs_aviso_somente_documentos';
-- ============================================================================

ALTER TABLE public.docs_conversas
  ADD COLUMN IF NOT EXISTS ultimo_aviso_automatico_at timestamptz;

COMMENT ON COLUMN public.docs_conversas.ultimo_aviso_automatico_at IS
  'Quando saiu a última resposta automática "número só de documentos". '
  'Reservada antes do envio (trava de 3h); volta a NULL se o envio falhar.';

INSERT INTO public.templates_mensagem (company_id, chave, texto, ativo)
SELECT c.id,
       'docs_aviso_somente_documentos',
       E'Olá! Este número é usado *somente para envio de documentos* e não é monitorado.\n\n'
       || E'Para falar com a nossa equipe, chame aqui: wa.me/5519991351061 😊',
       true
FROM public.companies c
WHERE c.id = '11111111-1111-1111-1111-111111111111'::uuid
ON CONFLICT (company_id, chave) DO NOTHING;
