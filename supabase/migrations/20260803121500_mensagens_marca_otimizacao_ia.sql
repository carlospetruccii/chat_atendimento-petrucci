-- Marca de autoria do texto: a mensagem saiu como a pessoa escreveu, ou a
-- sugestão da IA foi aceita?
--
-- Problema: o diálogo "Sugestão da IA" abre em TODO envio de texto do inbox, e
-- os dois botões (Enviar sugestão / Enviar original) chamavam o mesmo insert,
-- gravando só o texto final. Depois do envio não havia como saber se aquela
-- mensagem foi escrita pela atendente ou reescrita pela IA — nem os logs da
-- edge function `ai-texto` ajudam, porque ela é chamada nos dois caminhos e não
-- registra o texto.
--
-- otimizado_ia é NULLABLE de propósito, sem default:
--   true  = o texto enviado veio da sugestão da IA (aceita ou editada)
--   false = o texto é da pessoa (botão "Enviar original", ou a IA não mudou nada)
--   NULL  = não se sabe — mensagem anterior a esta migration, ou envio que não
--           passa pelo composer (bot, sistema, mídia, mensagem do cliente).
-- Um default false transformaria todo o histórico em "não otimizado", o que
-- seria mentira, não ausência de dado.

ALTER TABLE public.mensagens
  ADD COLUMN otimizado_ia boolean,
  ADD COLUMN content_original text;

COMMENT ON COLUMN public.mensagens.otimizado_ia IS
  'true = texto enviado veio da sugestão da IA (aceita ou editada); false = texto '
  'da própria pessoa; NULL = desconhecido (anterior ao recurso ou envio que não '
  'passa pelo composer).';

COMMENT ON COLUMN public.mensagens.content_original IS
  'O que a pessoa digitou antes da sugestão da IA. Preenchido só quando '
  'otimizado_ia = true, para permitir comparar o antes e o depois.';

-- Guardar o original sem marcar a otimização (ou marcando false) deixaria a
-- coluna sem significado.
ALTER TABLE public.mensagens
  ADD CONSTRAINT mensagens_content_original_chk CHECK (
    content_original IS NULL OR otimizado_ia IS TRUE
  );

-- A marca só vale como registro se ninguém puder reescrevê-la depois. Entra na
-- mesma trava de imutabilidade dos campos de identidade — os UPDATEs que o
-- sistema realmente faz (status_envio, status_whatsapp, zapi_message_id) não
-- tocam nessas colunas, então continuam passando.
--
-- O corpo abaixo é o da versão vigente (migration 20260512131452, que já havia
-- somado reply_to_message_id e afrouxado zapi_message_id para NULL -> valor)
-- mais o bloco novo. Reescrever a função a partir da versão original desfaria
-- essas duas mudanças e travaria o carimbo do zapi_message_id no envio.
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
     AND NEW.zapi_message_id IS DISTINCT FROM OLD.zapi_message_id THEN
    RAISE EXCEPTION 'zapi_message_id é imutável após preenchido';
  END IF;
  IF NEW.otimizado_ia IS DISTINCT FROM OLD.otimizado_ia
     OR NEW.content_original IS DISTINCT FROM OLD.content_original THEN
    RAISE EXCEPTION 'A marca de otimização por IA é imutável após o envio';
  END IF;
  RETURN NEW;
END;
$function$;
