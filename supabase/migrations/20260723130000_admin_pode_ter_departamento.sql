-- Permite atribuir um departamento a um administrador (opcional). O admin
-- continua enxergando tudo (RLS/visibilidade são por role, não por
-- department_id) — o departamento aqui só serve para o admin também receber
-- os avisos de novo pendente daquele setor (cron-notificacao-colaboradores),
-- em vez de o depto ficar sem ninguém pra avisar quando só tem um admin nele.
--
-- Antes, alterar_papel_membro zerava department_id sempre que promovia a
-- administrador. Agora usa o valor informado, igual já fazia para colaborador.
CREATE OR REPLACE FUNCTION public.alterar_papel_membro(
  p_user_id uuid,
  p_company_id uuid,
  p_is_admin boolean,
  p_department_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_dept uuid := p_department_id;
  v_role public.company_role := CASE WHEN p_is_admin THEN 'administrador' ELSE 'colaborador' END;
BEGIN
  -- Gate de acesso + departamento. Nunca toca contas de sistema.
  UPDATE public.users
     SET is_superadmin = p_is_admin,
         department_id = v_dept
   WHERE id = p_user_id
     AND is_system_user = false;

  -- Papel canônico + departamento espelhado, escopo da empresa.
  UPDATE public.company_members
     SET role = v_role,
         department_id = v_dept
   WHERE user_id = p_user_id
     AND company_id = p_company_id
     AND ativo = true;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.alterar_papel_membro(uuid, uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.alterar_papel_membro(uuid, uuid, boolean, uuid) TO service_role;
