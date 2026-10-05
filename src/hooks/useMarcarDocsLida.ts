import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { type DocsConversa, zerarNaoLidas } from "@/lib/docs-logic";
import { marcarDocsConversaLida } from "@/lib/docs-queries";
import { marcarDocsLidoNoWhatsapp } from "@/lib/docs-acoes";

/**
 * Leitura da conversa aberta no Docs, em dois níveis:
 *  - badge interno (marcar_docs_conversa_lida): para quem abriu, ao abrir e a
 *    cada mensagem nova do cliente. Zera o contador direto no cache da lista —
 *    recarregar a lista inteira a cada leitura era caro e realimentava o ciclo.
 *  - "tique azul" no WhatsApp do cliente: só o DONO, só com a aba visível e só
 *    quando chegou mensagem nova do cliente (espiar ou reabrir não confirma).
 */
export function useMarcarDocsLida(params: {
  conversaId: string;
  lastInboundAt: string | null;
  souDono: boolean;
}): void {
  const { conversaId, lastInboundAt, souDono } = params;
  const queryClient = useQueryClient();

  useEffect(() => {
    void marcarDocsConversaLida(conversaId).then(() => {
      queryClient.setQueriesData<DocsConversa[]>({ queryKey: ["docs", "conversas"] }, (lista) =>
        lista ? zerarNaoLidas(lista, conversaId) : lista,
      );
      queryClient.invalidateQueries({ queryKey: ["docs-unread-total"] });
    });
  }, [conversaId, lastInboundAt, queryClient]);

  // Última mensagem do cliente já confirmada — evita repetir o tique a cada
  // volta de foco da aba.
  const confirmadoRef = useRef<string | null>(null);
  useEffect(() => {
    if (!souDono || !lastInboundAt) return;
    const chave = `${conversaId}:${lastInboundAt}`;
    const confirmar = () => {
      if (document.visibilityState !== "visible" || confirmadoRef.current === chave) return;
      confirmadoRef.current = chave;
      void marcarDocsLidoNoWhatsapp(conversaId);
    };
    confirmar();
    document.addEventListener("visibilitychange", confirmar);
    return () => document.removeEventListener("visibilitychange", confirmar);
  }, [conversaId, lastInboundAt, souDono]);
}
