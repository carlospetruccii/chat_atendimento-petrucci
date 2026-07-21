-- Permite a troca de papel admin ↔ colaborador de um membro existente, de forma
-- segura e atômica. Duas peças:
--
-- 1) Ajuste no trigger protect_superadmin_flag: a invariante "is_superadmin é
--    imutável depois de TRUE" passa a valer SÓ no contexto autenticado
--    (auth.uid() IS NOT NULL). Um usuário logado nunca consegue rebaixar um
--    superadmin por UPDATE direto (ele sempre tem auth.uid()). Já o caminho
--    server-side sancionado (Edge Function via service_role, auth.uid() = NULL)
--    pode rebaixar — e esse caminho já confere que quem chama é o dono.
--
-- 2) RPC alterar_papel_membro: faz as DUAS escritas (users + company_members)
--    numa única transação, eliminando estado inconsistente. Só o service_role
--    pode executá-la (a autorização de "dono" fica na Edge Function).

-- 1) Trigger endurecido: invariante agora só no contexto autenticado.
CREATE OR REPLACE FUNCTION public.protect_superadmin_flag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_is_admin boolean;
BEGIN
  -- Travas de coluna e invariante de rebaixamento só se aplicam quando há um
  -- usuário autenticado. Chamadas server-side (service_role / definer) têm
  -- auth.uid() = NULL e são consideradas sancionadas pela camada que as chama.
  IF v_uid IS NOT NULL THEN
    v_is_admin := current_user_is_superadmin() OR has_permission('manage_users');
    IF NOT v_is_admin THEN
      IF NEW.is_superadmin IS DISTINCT FROM OLD.is_superadmin
         OR NEW.is_system_user IS DISTINCT FROM OLD.is_system_user
         OR NEW.department_id IS DISTINCT FROM OLD.department_id
         OR NEW.ativo IS DISTINCT FROM OLD.ativo THEN
        RAISE EXCEPTION 'Sem permissão para alterar campos administrativos do usuário'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    -- Invariante: ninguém rebaixa um superadmin por UPDATE direto (nem admin).
    IF OLD.is_superadmin = true AND NEW.is_superadmin IS DISTINCT FROM OLD.is_superadmin THEN
      RAISE EXCEPTION 'is_superadmin é imutável após ser definido como TRUE';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- 2) RPC transacional para a troca de papel. NÃO faz autorização de dono — isso
-- é responsabilidade da Edge Function chamadora (que roda com service_role).
-- Por isso o EXECUTE é revogado de todos os papéis de cliente.
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
  v_dept uuid := CASE WHEN p_is_admin THEN NULL ELSE p_department_id END;
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
