-- Desativar colaborador passa a cortar o acesso de verdade.
--
-- Antes: o botão "Desativar" só gravava users.ativo = false. Nada conferia isso:
-- o login continuava funcionando, current_user_is_superadmin() e
-- has_permission() ignoravam o ativo, e company_members.ativo seguia true (então
-- is_member_of/can_manage_config_in liberavam tudo). Um admin desativado via
-- todos os atendimentos e conseguia se reativar sozinho.
--
-- Agora, ao mudar users.ativo (pela tela, edição ou qualquer UPDATE):
--   - company_members.ativo acompanha (is_member_of e cia. já checam ele);
--   - desativar bloqueia o login no Auth (banned_until a 100 anos, o mesmo que
--     o ban_duration do GoTrue faria) e apaga as sessões (os refresh tokens caem
--     em cascata), então a pessoa sai em até 1h — o tempo de vida do token que
--     já estava na mão. Nesse meio tempo o banco já nega tudo (itens abaixo);
--   - reativar desfaz o bloqueio do login e religa o vínculo.
-- E:
--   - current_user_is_superadmin(), current_user_can_view_all() e
--     has_permission() exigem users.ativo;
--   - ninguém muda o PRÓPRIO ativo (nem admin se desativar, nem desativado se
--     reativar);
--   - desativar ficou poderoso (bane o login), então: o dono não é desativado
--     pela tela, só admin desativa admin (quem tem só manage_users, não) e a
--     empresa nunca fica sem nenhum admin ativo.
-- Edge functions com service_role validam o chamador por auth.getUser(), que
-- falha quando a sessão do JWT foi apagada — o DELETE em auth.sessions corta
-- também esse caminho, sem esperar o token expirar.
--
-- Idempotente: CREATE OR REPLACE e DROP TRIGGER IF EXISTS. O sincronismo inicial
-- só toca linhas divergentes (hoje nenhuma: ninguém está desativado).

CREATE OR REPLACE FUNCTION public.current_user_is_superadmin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
     WHERE id = auth.uid() AND is_superadmin = true AND ativo = true
  )
$$;

CREATE OR REPLACE FUNCTION public.has_permission(flag text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.user_permissions p
      JOIN public.users u ON u.id = p.user_id AND u.ativo = true
     WHERE p.user_id = auth.uid() AND p.permission = flag
  )
$$;

CREATE OR REPLACE FUNCTION public.current_user_can_view_all()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.current_user_is_superadmin() OR public.has_permission('view_all_departments')
$$;

-- Trava de campos administrativos. Acrescenta as regras do ativo (próprio,
-- dono, admin, último admin); o resto é igual ao que já estava em produção.
CREATE OR REPLACE FUNCTION public.protect_superadmin_flag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
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

    IF OLD.is_superadmin = true AND NEW.is_superadmin IS DISTINCT FROM OLD.is_superadmin THEN
      RAISE EXCEPTION 'is_superadmin e imutavel apos ser definido como TRUE';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Leva o ativo para o vínculo com a empresa e para o login.
CREATE OR REPLACE FUNCTION public.users_aplicar_ativo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.company_members
     SET ativo = NEW.ativo
   WHERE user_id = NEW.id
     AND ativo IS DISTINCT FROM NEW.ativo;

  IF NEW.ativo THEN
    UPDATE auth.users SET banned_until = NULL WHERE id = NEW.id;
  ELSE
    UPDATE auth.users SET banned_until = now() + interval '100 years' WHERE id = NEW.id;
    DELETE FROM auth.sessions WHERE user_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

-- Função de trigger não é RPC.
REVOKE EXECUTE ON FUNCTION public.users_aplicar_ativo() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_users_aplicar_ativo ON public.users;
CREATE TRIGGER trg_users_aplicar_ativo
  AFTER UPDATE OF ativo ON public.users
  FOR EACH ROW
  WHEN (NEW.ativo IS DISTINCT FROM OLD.ativo)
  EXECUTE FUNCTION public.users_aplicar_ativo();

-- Sincronismo inicial: só DESLIGA vínculo de quem já está desativado. Nunca
-- religa (um vínculo desligado à mão continua desligado).
-- Reativar pela tela religa todos os vínculos da pessoa: hoje há uma empresa só.
UPDATE public.company_members m
   SET ativo = false
  FROM public.users u
 WHERE u.id = m.user_id
   AND u.ativo = false
   AND m.ativo = true;

UPDATE auth.users a
   SET banned_until = now() + interval '100 years'
  FROM public.users u
 WHERE u.id = a.id
   AND u.ativo = false
   AND (a.banned_until IS NULL OR a.banned_until < now());
