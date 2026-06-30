
-- Fixar search_path nas funções de trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_superadmin_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.is_superadmin = true AND NEW.is_superadmin IS DISTINCT FROM OLD.is_superadmin THEN
    RAISE EXCEPTION 'is_superadmin é imutável após ser definido como TRUE';
  END IF;
  RETURN NEW;
END;
$$;

-- Restringir EXECUTE das funções SECURITY DEFINER ao role authenticated
REVOKE EXECUTE ON FUNCTION public.current_user_department() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_permission(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.current_user_can_view_all() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.current_user_is_superadmin() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.current_user_department() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_permission(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_can_view_all() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_is_superadmin() TO authenticated;
