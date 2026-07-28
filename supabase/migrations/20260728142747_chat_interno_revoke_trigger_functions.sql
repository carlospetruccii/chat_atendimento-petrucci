-- Tranca as funções internas do chat da equipe contra chamada direta via RPC.
--
-- Mesmo tratamento (e mesmo motivo) de `20260727121946_grupos_revoke_trigger_functions`:
-- o advisor do Supabase apontou `update_conversa_interna_last_message_at()` —
-- SECURITY DEFINER, para atualizar `conversas_internas` a partir do INSERT em
-- `mensagens_internas` — exposta em /rest/v1/rpc/, inclusive para `anon`.
-- Fora de um trigger ela até falha (não há NEW), mas função SECURITY DEFINER
-- alcançável pelo cliente é superfície sem nenhum ganho: o trigger roda com o
-- dono da tabela, não com o EXECUTE de quem chamou.
--
-- `pode_conversar_internamente` entra na lista por least privilege: quem a chama
-- é `abrir_conversa_interna`, que é SECURITY DEFINER e portanto executa como o
-- dono — o cliente nunca precisa do EXECUTE dela.
--
-- NÃO afeta:
--   - abrir_conversa_interna / enviar_mensagem_interna / enviar_midia_interna /
--     marcar_conversa_interna_lida → são a API da aba Equipe de propósito, e cada
--     uma valida auth.uid() + participação internamente;
--   - pode_escrever_midia_interna → é avaliada DENTRO da policy de INSERT do
--     Storage, que roda como o usuário; sem EXECUTE o upload quebraria.

REVOKE EXECUTE ON FUNCTION public.update_conversa_interna_last_message_at()
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.block_mensagem_interna_update_delete()
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.pode_conversar_internamente(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
