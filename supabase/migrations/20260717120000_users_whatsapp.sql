-- Adiciona o WhatsApp pessoal do colaborador, usado para notificá-lo quando
-- um atendimento é repassado/atribuído a ele. Armazenado em E.164 (+55...),
-- mesmo formato de sessoes_triagem.numero_whatsapp.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS whatsapp text;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_whatsapp_e164_chk;

ALTER TABLE public.users
  ADD CONSTRAINT users_whatsapp_e164_chk
  CHECK (whatsapp IS NULL OR whatsapp ~ '^\+[1-9][0-9]{7,14}$');

COMMENT ON COLUMN public.users.whatsapp IS
  'WhatsApp pessoal do colaborador em E.164 (+55...). Usado para notificar via WhatsApp quando um atendimento é repassado/atribuído a ele.';
