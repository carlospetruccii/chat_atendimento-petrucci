ALTER TABLE public.clients ADD COLUMN chat_lid TEXT;

CREATE UNIQUE INDEX uniq_clients_chat_lid
  ON public.clients (chat_lid)
  WHERE chat_lid IS NOT NULL;

COMMENT ON COLUMN public.clients.chat_lid IS
  'Linked Identifier (LID) do WhatsApp para este cliente, capturado da Z-API. Usado para resolver mensagens fromMe:true que vêm com LID em vez de E.164. Ver ADR-045.';