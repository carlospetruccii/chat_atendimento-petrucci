-- Contatos unificados: junta os contatos sincronizados do Google (tabela
-- `contatos`) com os clientes cadastrados manualmente no sistema (tabela
-- `clients`) que ainda não têm um contato Google correspondente pelo mesmo
-- numero_whatsapp.
--
-- Motivo: a tela "Contatos" (/contatos) só lia da tabela `contatos`, que é
-- escrita exclusivamente pelo sync do Google. Um cliente cadastrado via
-- "Adicionar contato" (tabela `clients`) nunca aparecia lá, então nunca
-- tinha o botão "Conversar" — mesmo já sendo um client_id válido, pronto
-- para iniciar atendimento.
--
-- security_invoker = true: a view roda com o papel de quem consulta, então
-- as policies de RLS de `contatos` e `clients` (hoje: is_member_of(company_id),
-- que libera tudo com auth_enforcement off) continuam valendo através dela.
CREATE OR REPLACE VIEW public.contatos_unificados
WITH (security_invoker = true) AS
SELECT
  g.id,
  g.company_id,
  g.nome,
  g.numero_whatsapp,
  g.numero_raw,
  g.emails,
  'google'::text AS origem
FROM public.contatos g
UNION ALL
SELECT
  c.id,
  c.company_id,
  c.nome,
  c.numero_whatsapp,
  NULL::text AS numero_raw,
  '[]'::jsonb AS emails,
  'sistema'::text AS origem
FROM public.clients c
WHERE NOT EXISTS (
  SELECT 1
  FROM public.contatos g2
  WHERE g2.company_id = c.company_id
    AND g2.numero_whatsapp = c.numero_whatsapp
);

GRANT SELECT ON public.contatos_unificados TO anon, authenticated;
