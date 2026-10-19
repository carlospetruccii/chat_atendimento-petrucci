-- Administrador pode alterar os PRÓPRIOS departamentos.
--
-- Antes: setores de administrador só o dono mudava, inclusive os do próprio
-- admin. Para admin, setor só define de quais departamentos ele recebe aviso
-- de novo pendente (ele já vê tudo), então mexer nos próprios é seguro.
-- Setores de OUTRO administrador continuam só com o dono.
--
-- Idempotente: CREATE OR REPLACE. Resto das funções igual a 20261016193222.

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.protect_superadmin_flag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_is_admin boolean;
BEGIN
  IF v_uid IS NOT NULL THEN
    IF v_uid = OLD.id AND NEW.ativo IS DISTINCT FROM OLD.ativo THEN
      RAISE EXCEPTION 'Ninguém pode ativar ou desativar o próprio acesso'
        USING ERRCODE = '42501';
    END IF;

    IF OLD.ativo AND NOT NEW.ativo THEN
      IF EXISTS (SELECT 1 FROM public.company_members m
                  WHERE m.user_id = OLD.id AND m.role = 'dono') THEN
        RAISE EXCEPTION 'O dono da empresa não pode ser desativado'
          USING ERRCODE = '42501';
      END IF;
      IF OLD.is_superadmin AND NOT current_user_is_superadmin() THEN
        RAISE EXCEPTION 'Só um administrador pode desativar outro administrador'
          USING ERRCODE = '42501';
      END IF;
      IF OLD.is_superadmin AND NOT EXISTS (
           SELECT 1 FROM public.users u
            WHERE u.id <> OLD.id AND u.ativo AND u.is_superadmin
              AND NOT coalesce(u.is_system_user, false)) THEN
        RAISE EXCEPTION 'Não dá para desativar o último administrador ativo'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    v_is_admin := current_user_is_superadmin() OR has_permission('manage_users');
    IF NOT v_is_admin THEN
      IF NEW.is_superadmin IS DISTINCT FROM OLD.is_superadmin
         OR NEW.is_system_user IS DISTINCT FROM OLD.is_system_user
         OR NEW.department_id IS DISTINCT FROM OLD.department_id
         OR NEW.ativo IS DISTINCT FROM OLD.ativo THEN
        RAISE EXCEPTION 'Sem permissao para alterar campos administrativos do usuario'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF OLD.is_superadmin
       AND v_uid <> OLD.id
       AND NEW.department_id IS DISTINCT FROM OLD.department_id
       AND NOT EXISTS (SELECT 1 FROM public.company_members m
                        WHERE m.user_id = v_uid AND m.role = 'dono' AND m.ativo = true) THEN
      RAISE EXCEPTION 'Só o dono altera os departamentos de outro administrador'
        USING ERRCODE = '42501';
    END IF;

    IF OLD.is_superadmin = true AND NEW.is_superadmin IS DISTINCT FROM OLD.is_superadmin THEN
      RAISE EXCEPTION 'is_superadmin e imutavel apos ser definido como TRUE';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.definir_departamentos_usuario(
  p_user_id uuid,
  p_department_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_is_admin boolean;
  v_is_system boolean;
  v_invalidos int;
BEGIN
  SELECT is_superadmin, is_system_user INTO v_is_admin, v_is_system
    FROM public.users WHERE id = p_user_id;
  IF NOT FOUND OR v_is_system THEN
    RAISE EXCEPTION 'Colaborador não encontrado' USING ERRCODE = 'P0002';
  END IF;

  IF v_uid IS NOT NULL THEN
    IF NOT (public.current_user_is_superadmin() OR public.has_permission('manage_users')) THEN
      RAISE EXCEPTION 'Sem permissão para alterar departamentos' USING ERRCODE = '42501';
    END IF;
    IF v_is_admin AND v_uid <> p_user_id AND NOT EXISTS (
      SELECT 1 FROM public.company_members m
       WHERE m.user_id = v_uid AND m.role = 'dono' AND m.ativo = true
    ) THEN
      RAISE EXCEPTION 'Só o dono altera os departamentos de outro administrador'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT coalesce(array_agg(x.d ORDER BY x.ord), '{}') INTO v_ids
    FROM (
      SELECT t.d, min(t.ord) AS ord
        FROM unnest(coalesce(p_department_ids, '{}')) WITH ORDINALITY AS t(d, ord)
       WHERE t.d IS NOT NULL
       GROUP BY t.d
    ) x;

  IF NOT v_is_admin AND cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'Colaborador precisa de pelo menos um departamento'
      USING ERRCODE = '22023';
  END IF;

  -- Cada setor precisa existir e ser de uma empresa da pessoa.
  SELECT count(*) INTO v_invalidos
    FROM unnest(v_ids) AS x(d)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.departments dp
       JOIN public.company_members m ON m.company_id = dp.company_id
      WHERE dp.id = x.d AND m.user_id = p_user_id
   );
  IF v_invalidos > 0 THEN
    RAISE EXCEPTION 'Departamento inválido' USING ERRCODE = '22023';
  END IF;

  -- Principal primeiro: o trigger ajusta company_members e garante que ele
  -- está na lista. Depois a lista é igualada ao pedido.
  UPDATE public.users SET department_id = v_ids[1] WHERE id = p_user_id;

  DELETE FROM public.user_departments
   WHERE user_id = p_user_id
     AND NOT (department_id = ANY (v_ids));

  INSERT INTO public.user_departments (user_id, department_id)
  SELECT p_user_id, d FROM unnest(v_ids) AS d
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.definir_departamentos_usuario(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.definir_departamentos_usuario(uuid, uuid[]) TO authenticated, service_role;
