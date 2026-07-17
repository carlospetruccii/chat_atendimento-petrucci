-- (EXPAND — não quebra nada, pode ser aplicada antes do deploy do frontend novo)
-- Cria a RPC de leitura controlada do WhatsApp pessoal. Enquanto a coluna
-- users.whatsapp ainda estiver legível (ver migration de CONTRACT), o cliente
-- antigo segue funcionando; o cliente novo passa a ler o número por aqui.
--
-- Devolve id+whatsapp apenas para admin (superadmin OU manage_users) — que vê
-- todos — e para a própria linha do chamador.
CREATE OR REPLACE FUNCTION public.admin_list_user_whatsapps()
RETURNS TABLE (id uuid, whatsapp text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT u.id, u.whatsapp
  FROM public.users u
  WHERE u.is_system_user = false
    AND (
      public.current_user_is_superadmin()
      OR public.has_permission('manage_users')
      OR u.id = auth.uid()
    );
$function$;

COMMENT ON FUNCTION public.admin_list_user_whatsapps() IS
  'Retorna id+whatsapp dos colaboradores. Visível apenas para admin (superadmin ou manage_users) — que vê todos — e para o próprio usuário (só a sua linha). Usado pela tela de Colaboradores.';

-- EXECUTE só para usuário autenticado (e service_role). anon/PUBLIC não chamam.
REVOKE ALL ON FUNCTION public.admin_list_user_whatsapps() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_user_whatsapps() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_list_user_whatsapps() TO authenticated, service_role;
