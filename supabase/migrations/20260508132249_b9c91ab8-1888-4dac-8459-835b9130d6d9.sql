
-- Cria bucket privado para mídias inbound recebidas via Z-API webhook.
-- Apenas service_role escreve (edge function). Leitura pelo frontend usa URL assinada.
INSERT INTO storage.buckets (id, name, public)
VALUES ('mensagens-midia', 'mensagens-midia', false)
ON CONFLICT (id) DO NOTHING;

-- Policy: apenas service_role lê/escreve neste bucket. Frontend usa URLs assinadas
-- (signed URLs ignoram RLS). Não criamos policies para anon/authenticated.
-- service_role bypassa RLS automaticamente, então não precisa policy adicional.
