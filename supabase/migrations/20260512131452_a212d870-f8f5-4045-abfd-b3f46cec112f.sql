
ALTER TABLE public.mensagens
  ADD COLUMN reply_to_message_id uuid REFERENCES public.mensagens(id) ON DELETE SET NULL;

CREATE INDEX idx_mensagens_reply_to
  ON public.mensagens(reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

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
  RETURN NEW;
END;
$function$;
