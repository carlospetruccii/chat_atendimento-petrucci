-- Apagar para todos + editar mensagem (recursos NATIVOS do WhatsApp, expostos
-- pela uazapi em POST /message/delete e POST /message/edit).
--
-- Nada aqui é DELETE de verdade. A linha fica:
--   - reply_to_message_id aponta para mensagens (FK); apagar a linha derrubaria
--     a citação de quem respondeu a ela;
--   - o histórico do atendimento precisa mostrar que houve uma mensagem ali,
--     igual ao "Esta mensagem foi apagada" do WhatsApp.
-- Então apagar = carimbar apagada_em e esvaziar o conteúdo.

ALTER TABLE public.mensagens
  ADD COLUMN apagada_em timestamptz,
  ADD COLUMN apagada_por_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN editada_em timestamptz;

COMMENT ON COLUMN public.mensagens.apagada_em IS
  'Quando a mensagem foi apagada para todos no WhatsApp. NULL = não apagada. '
  'Ao carimbar, content/media_url são esvaziados — a linha sobrevive só como '
  'marcador ("Esta mensagem foi apagada").';

COMMENT ON COLUMN public.mensagens.apagada_por_user_id IS
  'Quem apagou. NULL quando o carimbo veio do webhook (o cliente apagou uma '
  'mensagem dele, ou alguém apagou pelo celular da empresa).';

COMMENT ON COLUMN public.mensagens.editada_em IS
  'Quando o texto foi editado pela última vez (WhatsApp permite ~15 min após o '
  'envio). NULL = nunca editada. O texto atual continua em content.';

-- Grupos usam o mesmo webhook de status, então recebem as mesmas colunas para o
-- carimbo vindo de fora funcionar nos dois caminhos. A UI de grupo ainda não
-- oferece apagar/editar — ver nota no fim do arquivo.
ALTER TABLE public.grupo_mensagens
  ADD COLUMN apagada_em timestamptz,
  ADD COLUMN editada_em timestamptz;

COMMENT ON COLUMN public.grupo_mensagens.apagada_em IS
  'Igual a mensagens.apagada_em. Hoje só é preenchido pelo webhook (quando um '
  'participante apaga para todos).';

COMMENT ON COLUMN public.grupo_mensagens.editada_em IS
  'Igual a mensagens.editada_em. Hoje só é preenchido pelo webhook.';

-- Lista de conversas e chat filtram/rotulam por apagada_em; sem índice o
-- planner varre a tabela inteira nas consultas por atendimento recente.
CREATE INDEX mensagens_apagada_em_idx
  ON public.mensagens (atendimento_id, created_at DESC)
  WHERE apagada_em IS NOT NULL;

-- ————————————————————————————————————————————————————————————————
-- Abre espaço para a mensagem esvaziada
-- ————————————————————————————————————————————————————————————————
-- Duas CHECKs existentes exigem conteúdo: texto tem que ter `content`, mídia tem
-- que ter `media_url`. São invariantes CERTAS para mensagem viva e impossíveis
-- para mensagem apagada — sem esta mudança o UPDATE do apagar estoura com
-- "violates check constraint" DEPOIS de a mensagem já ter sido revogada no
-- WhatsApp: o cliente deixa de ver, e o nosso chat continua mostrando o texto.
--
-- O relaxamento é condicionado a apagada_em IS NOT NULL, então a garantia
-- continua valendo integralmente para todo o resto.
ALTER TABLE public.mensagens
  DROP CONSTRAINT mensagens_texto_content_chk,
  ADD CONSTRAINT mensagens_texto_content_chk CHECK (
    tipo <> 'texto' OR content IS NOT NULL OR apagada_em IS NOT NULL
  );

ALTER TABLE public.mensagens
  DROP CONSTRAINT mensagens_media_url_chk,
  ADD CONSTRAINT mensagens_media_url_chk CHECK (
    tipo IN ('texto', 'localizacao', 'contato')
    OR media_url IS NOT NULL
    OR apagada_em IS NOT NULL
  );

ALTER TABLE public.grupo_mensagens
  DROP CONSTRAINT grupo_mensagens_texto_content_chk,
  ADD CONSTRAINT grupo_mensagens_texto_content_chk CHECK (
    tipo <> 'texto' OR content IS NOT NULL OR apagada_em IS NOT NULL
  );

ALTER TABLE public.grupo_mensagens
  DROP CONSTRAINT grupo_mensagens_media_url_chk,
  ADD CONSTRAINT grupo_mensagens_media_url_chk CHECK (
    tipo IN ('texto', 'localizacao', 'contato')
    OR media_url IS NOT NULL
    OR apagada_em IS NOT NULL
  );

-- ————————————————————————————————————————————————————————————————
-- Trava de imutabilidade: abre a exceção que a edição exige
-- ————————————————————————————————————————————————————————————————
-- POST /message/edit da uazapi GERA UM ID NOVO para a mensagem editada, e é esse
-- id que os eventos seguintes (status, eco, delete) vão citar. Sem trocar o
-- zapi_message_id, a mensagem editada fica órfã: "entregue/lido" nunca mais
-- chega nela e apagar depois falha com 404.
--
-- A troca continua proibida no caso geral (é o que garante a idempotência do
-- webhook). A exceção é estreita: só passa no MESMO UPDATE que carimba
-- editada_em, que é exatamente o que a edge function faz.
--
-- O corpo abaixo é o da versão vigente em produção (conferido via prosrc,
-- md5 8962077b5f216cf7a5346f4c81e63ca1) mais os blocos novos. Reescrever a
-- partir de uma versão anterior desfaria as travas de otimizado_ia.
CREATE OR REPLACE FUNCTION public.protect_mensagem_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.atendimento_id IS DISTINCT FROM OLD.atendimento_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.sender_type IS DISTINCT FROM OLD.sender_type
     OR NEW.sent_by_user_id IS DISTINCT FROM OLD.sent_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.reply_to_message_id IS DISTINCT FROM OLD.reply_to_message_id THEN
    RAISE EXCEPTION 'Campos de identidade da mensagem são imutáveis após inserção';
  END IF;

  IF OLD.zapi_message_id IS NOT NULL
     AND NEW.zapi_message_id IS DISTINCT FROM OLD.zapi_message_id
     AND NEW.editada_em IS NOT DISTINCT FROM OLD.editada_em THEN
    RAISE EXCEPTION 'zapi_message_id é imutável após preenchido (exceto na edição da mensagem)';
  END IF;

  IF NEW.otimizado_ia IS DISTINCT FROM OLD.otimizado_ia
     OR NEW.content_original IS DISTINCT FROM OLD.content_original THEN
    RAISE EXCEPTION 'A marca de otimização por IA é imutável após o envio';
  END IF;

  -- Apagar é irreversível no WhatsApp; no banco também. Sem isso, "desapagar"
  -- ressuscitaria uma bolha vazia e mentiria sobre o que o cliente viu.
  IF OLD.apagada_em IS NOT NULL AND NEW.apagada_em IS DISTINCT FROM OLD.apagada_em THEN
    RAISE EXCEPTION 'apagada_em é imutável após a mensagem ser apagada';
  END IF;

  -- Editar de novo é permitido (novo carimbo), remover a marca não é.
  IF OLD.editada_em IS NOT NULL AND NEW.editada_em IS NULL THEN
    RAISE EXCEPTION 'editada_em não pode ser removido';
  END IF;

  RETURN NEW;
END;
$function$;

-- Nota de escopo: a UI de apagar/editar entra só no inbox de atendimento
-- (tabela mensagens). Grupo tem painel próprio e o carimbo por webhook já
-- funciona; oferecer os botões lá é trabalho separado.
