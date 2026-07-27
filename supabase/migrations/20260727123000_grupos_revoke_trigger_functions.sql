-- Tranca as funções de TRIGGER de grupo contra chamada direta via RPC.
--
-- O advisor do Supabase (anon/authenticated_security_definer_function_executable)
-- apontou que `update_grupo_last_message_at()` — SECURITY DEFINER, para poder
-- atualizar `grupos` a partir do INSERT em `grupo_mensagens` — ficava exposta em
-- /rest/v1/rpc/. Chamada fora de um trigger ela até falha (não há NEW), mas
-- função SECURITY DEFINER alcançável pelo cliente é superfície de ataque sem
-- nenhum ganho: o trigger executa com o dono da tabela, não com o EXECUTE do
-- chamador. Mesmo tratamento que `update_atendimento_last_message_at` já tem.
--
-- Não afeta `marcar_grupo_lido`, que é RPC de propósito (chamada pela Inbox) e
-- fixa user_id = auth.uid() internamente.

REVOKE EXECUTE ON FUNCTION public.update_grupo_last_message_at()
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.protect_grupo_mensagem_immutable_fields()
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.block_grupo_mensagem_delete()
  FROM PUBLIC, anon, authenticated;
