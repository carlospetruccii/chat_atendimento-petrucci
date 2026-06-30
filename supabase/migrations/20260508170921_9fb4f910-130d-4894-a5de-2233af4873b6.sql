
CREATE TABLE public.notificacoes_luana (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  atendimento_id uuid NOT NULL REFERENCES public.atendimentos(id) ON DELETE CASCADE,
  mensagem_texto text NOT NULL,
  lida boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notif_luana_atendimento ON public.notificacoes_luana(atendimento_id);
CREATE INDEX idx_notif_luana_nao_lidas ON public.notificacoes_luana(created_at DESC) WHERE lida = false;

ALTER TABLE public.notificacoes_luana ENABLE ROW LEVEL SECURITY;

CREATE POLICY notif_luana_select ON public.notificacoes_luana
  FOR SELECT TO authenticated
  USING (
    public.current_user_is_superadmin()
    OR public.has_permission('view_all_departments')
    OR public.has_permission('view_luana_notifications')
  );

CREATE POLICY notif_luana_update ON public.notificacoes_luana
  FOR UPDATE TO authenticated
  USING (
    public.current_user_is_superadmin()
    OR public.has_permission('view_luana_notifications')
  )
  WITH CHECK (
    public.current_user_is_superadmin()
    OR public.has_permission('view_luana_notifications')
  );

-- Sem policy de INSERT/DELETE: somente service_role (que bypassa RLS) pode inserir.

-- Concede permissão à Luana (idempotente; só aplica se o usuário existir neste projeto)
INSERT INTO public.user_permissions (user_id, permission)
SELECT '2b1fdda2-1464-41db-b80b-b7342e8ae16d', 'view_luana_notifications'
WHERE EXISTS (SELECT 1 FROM public.users WHERE id = '2b1fdda2-1464-41db-b80b-b7342e8ae16d')
ON CONFLICT DO NOTHING;
