-- Corrige contatos_unificados: o dedupe entre `contatos` (Google) e `clients`
-- comparava numero_whatsapp por igualdade exata, mas o sync do Google NÃO
-- força o nono dígito de celulares BR (normalizarTelefone em
-- _shared/google-people.ts preserva o formato que a People API devolveu),
-- enquanto `cadastrar-cliente` sempre canoniza para a forma com nono dígito
-- (numeroCanonicoWhatsapp). Resultado: a mesma pessoa aparecia duas vezes na
-- tela Contatos — uma vinda do Google, outra do sistema — sempre que o
-- contato do Google estava salvo sem o nono dígito. Confirmado com dados
-- reais em produção (3 pares duplicados) antes desta correção.
--
-- Mesma regra de equivalência de variantesNumeroWhatsappBR
-- (supabase/functions/_shared/telefone-whatsapp.ts), reescrita em SQL: dois
-- números BR são a mesma linha de assinante com/sem o "9" logo após o DDD.
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
    AND g2.numero_whatsapp IS NOT NULL
    AND (
      g2.numero_whatsapp = c.numero_whatsapp
      OR g2.numero_whatsapp = regexp_replace(c.numero_whatsapp, '^(\+55\d{2})9(\d{8})$', '\1\2')
      OR c.numero_whatsapp = regexp_replace(g2.numero_whatsapp, '^(\+55\d{2})9(\d{8})$', '\1\2')
    )
);

GRANT SELECT ON public.contatos_unificados TO anon, authenticated;
