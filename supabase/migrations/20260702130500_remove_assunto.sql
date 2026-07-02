-- ============================================================================
-- REMOÇÃO DEFINITIVA DO CONCEITO DE "ASSUNTO"
-- ============================================================================
-- O bot passa a triar SÓ por departamento; assunto sai do sistema inteiro.
--
-- O que é removido e as dependências (FKs):
--   • public.subjects .................. tabela dos assuntos (o alvo).
--   • public.especialista_routing ...... regra "assunto → atendente especialista"
--        (dependia 100% de subjects; o novo fluxo vai direto pra Pendentes).
--   • public.atendimentos.subject_id ... coluna do assunto (FK simples + FK
--        composta com company_id) — dropar a coluna remove ambas.
--   • view public.vw_pendentes ......... recriada sem assunto.
--   • função public.payload_notificacao_luana ... recriada sem 'assunto'.
--   • template 'triagem_pergunta_assunto' ... removido.
--
-- NÃO acorda o multi-empresa: a trava auth_enforcement_enabled fica em 'false';
-- nenhuma RLS/company_id é ligada aqui — só removemos objetos e recriamos a
-- view/função sem o campo assunto.
-- ============================================================================

BEGIN;

-- 1) A view depende da coluna subject_id e da tabela subjects; precisa cair antes
--    (CREATE OR REPLACE não permite remover colunas de uma view existente).
DROP VIEW IF EXISTS public.vw_pendentes;

-- 2) Roteamento por especialista: tabela inteira (FK, índice, trigger de
--    auditoria e RLS caem junto com ela).
DROP TABLE IF EXISTS public.especialista_routing;

-- 3) Coluna de assunto do atendimento (remove FK simples e FK composta).
ALTER TABLE public.atendimentos DROP COLUMN IF EXISTS subject_id;

-- 4) Nada mais referencia subjects → pode cair (trigger de auditoria, RLS,
--    UNIQUE(id, company_id) e FK para departments caem junto).
DROP TABLE IF EXISTS public.subjects;

-- 5) Recria a view de pendentes SEM assunto (idêntica à original, menos subject).
CREATE OR REPLACE VIEW public.vw_pendentes
WITH (security_invoker = true)
AS
SELECT
  a.id AS atendimento_id,
  a.client_id,
  c.nome AS nome_cliente,
  c.numero_whatsapp,
  a.current_department_id,
  d.nome AS departamento_nome,
  a.escalated_from_user_id,
  a.escalated_from_department_id,
  a.created_at,
  a.last_message_at,
  a.transferred_count,
  EXTRACT(EPOCH FROM (now() - COALESCE(a.last_message_at, a.created_at))) / 60.0
    AS tempo_aguardando_minutos
FROM public.atendimentos a
JOIN public.clients c ON c.id = a.client_id
LEFT JOIN public.departments d ON d.id = a.current_department_id
WHERE a.status = 'pendente';

-- 6) Recria o payload da notificação à supervisão SEM o campo 'assunto'.
CREATE OR REPLACE FUNCTION public.payload_notificacao_luana(p_atendimento_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_minutos integer;
  v_horas integer;
  v_resto integer;
  v_tempo text;
  v_payload jsonb;
BEGIN
  SELECT
    COALESCE(EXTRACT(EPOCH FROM (now() - COALESCE(a.last_message_at, a.created_at))) / 60, 0)::int
  INTO v_minutos
  FROM public.atendimentos a
  WHERE a.id = p_atendimento_id;

  IF v_minutos IS NULL THEN
    RETURN NULL;
  END IF;

  v_horas := v_minutos / 60;
  v_resto := v_minutos % 60;
  IF v_horas > 0 THEN
    v_tempo := v_horas || 'h ' || v_resto || 'min';
  ELSE
    v_tempo := v_resto || 'min';
  END IF;

  SELECT jsonb_build_object(
    'nome_cliente', COALESCE(c.nome, c.numero_whatsapp),
    'telefone', c.numero_whatsapp,
    'departamento', COALESCE(d.nome, '—'),
    'tempo_aguardando', v_tempo
  )
  INTO v_payload
  FROM public.atendimentos a
  JOIN public.clients c ON c.id = a.client_id
  LEFT JOIN public.departments d ON d.id = a.current_department_id
  WHERE a.id = p_atendimento_id;

  RETURN v_payload;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.payload_notificacao_luana(uuid) FROM PUBLIC, anon;

-- 7) Remove o template da pergunta de assunto (o bot não pergunta mais assunto).
DELETE FROM public.templates_mensagem WHERE chave = 'triagem_pergunta_assunto';

COMMIT;
