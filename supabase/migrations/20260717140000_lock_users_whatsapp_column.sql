-- (CONTRACT — APLICAR SOMENTE APÓS O DEPLOY do frontend que usa a RPC
--  admin_list_user_whatsapps(). Se aplicada antes do deploy, a tela de
--  Colaboradores ANTIGA — que faz `select whatsapp` direto — quebra com
--  permission denied.)
--
-- LGPD/PII: users.whatsapp (telefone pessoal, E.164) estava legível por QUALQUER
-- usuário autenticado, porque o role `authenticated` tinha SELECT no nível da
-- TABELA (cobre todas as colunas) e a policy users_select_authenticated é
-- USING (true). Esta migration remove o SELECT amplo e reconcede SELECT apenas
-- nas colunas NÃO sensíveis — `whatsapp` fica de fora. O número passa a ser lido
-- só pela RPC admin_list_user_whatsapps() (admin ou a própria linha).
--
-- service_role (Edge Functions notificar-repasse / criar-colaborador) NÃO é
-- afetado: continua lendo users.whatsapp direto (bypassa GRANTs de coluna).
REVOKE SELECT ON public.users FROM authenticated;
REVOKE SELECT (whatsapp) ON public.users FROM authenticated;

GRANT SELECT (
  id,
  nome,
  email,
  department_id,
  ativo,
  disponivel,
  is_system_user,
  is_superadmin,
  created_at,
  updated_at
) ON public.users TO authenticated;
