-- Corrige escalonamento de privilégio: a policy de UPDATE permite o usuário
-- editar a própria linha, e o trigger antigo só bloqueava is_superadmin
-- TRUE->FALSE, deixando passar FALSE->TRUE. Um colaborador comum podia então
-- se tornar superadmin com um UPDATE direto na própria linha.
--
-- Nova regra (defense-in-depth no BEFORE UPDATE, independe da policy):
--  - Contexto server-side (service_role / SECURITY DEFINER sem auth.uid()):
--    não aplica as travas de coluna.
--  - Usuário autenticado NÃO admin: não pode alterar colunas administrativas
--    (is_superadmin, is_system_user, department_id, ativo) — nem na própria
--    linha. Continua livre para nome/whatsapp/disponivel.
--  - Admin (superadmin ou manage_users): pode alterar.
--  - Invariante mantida: is_superadmin é imutável depois de definido como TRUE.
CREATE OR REPLACE FUNCTION public.protect_superadmin_flag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_is_admin boolean;
BEGIN
  -- Só aplica as travas de coluna quando há um usuário autenticado no contexto.
  -- Chamadas server-side (service_role / definer) têm auth.uid() = NULL.
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
  END IF;

  -- Invariante existente: superadmin não pode ser rebaixado uma vez definido.
  IF OLD.is_superadmin = true AND NEW.is_superadmin IS DISTINCT FROM OLD.is_superadmin THEN
    RAISE EXCEPTION 'is_superadmin é imutável após ser definido como TRUE';
  END IF;

  RETURN NEW;
END;
$function$;
