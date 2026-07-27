-- Alinha o bloqueio de DELETE de mensagem de grupo com o do chat individual.
--
-- `block_grupo_mensagem_delete` só liberava `service_role`, enquanto o
-- `block_mensagem_delete` (individual, migration 20260507184906) libera
-- service_role OU superadmin. A diferença criava uma assimetria com efeito real:
-- `companies` cascateia para `grupos` e daí para `grupo_mensagens`, então apagar
-- uma empresa como superadmin funcionava para `mensagens` e falhava para
-- `grupo_mensagens` — deixando a exclusão pela metade.
--
-- A garantia de append-only continua: ninguém além de backend/superadmin apaga.
CREATE OR REPLACE FUNCTION public.block_grupo_mensagem_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user = 'service_role' THEN
    RETURN OLD;
  END IF;
  IF public.current_user_is_superadmin() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'DELETE em grupo_mensagens é restrito a service_role ou superadmin';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.block_grupo_mensagem_delete()
  FROM PUBLIC, anon, authenticated;
