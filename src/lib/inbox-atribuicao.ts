import type { InboxConversation } from "@/lib/inbox-queries";

/**
 * Reflete "assumir atendimento" na lista de conversas já em cache.
 *
 * A RPC atribui no banco, mas a tela só descobre refazendo a lista — e essa
 * consulta pode falhar (statement timeout) justo nessa hora. Sem isto a
 * conversa seguia em "Modo supervisão", sem campo de digitar, até recarregar.
 * A lista de verdade chega depois (invalidate) e substitui este palpite.
 */
export function aplicarAtribuicao(
  conversas: InboxConversation[] | undefined,
  atendimentoId: string,
  usuario: { id: string; nome: string },
): InboxConversation[] | undefined {
  if (!conversas) return conversas;
  return conversas.map((c) =>
    c.id === atendimentoId
      ? { ...c, status: "em_atendimento", assignedTo: usuario.id, assignedNome: usuario.nome }
      : c,
  );
}
