import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { criarAgendador } from "@/lib/docs-logic";

/** Callbacks do chat aberto (DocsChatPanel registra os do useDocsHistory). */
export interface DocsRealtimeCbs {
  onInsert: (messageId: string, conversaId: string) => void;
  onUpdate: (messageId: string, conversaId: string) => void;
  onDelete: (messageId: string) => void;
}

/** "Nenhum chat aberto" — o painel registra isto ao desmontar. */
export const CBS_VAZIOS: DocsRealtimeCbs = {
  onInsert: () => {},
  onUpdate: () => {},
  onDelete: () => {},
};

/**
 * Janela de agrupamento das recargas da lista. Um disparo em massa de
 * documentos são centenas de INSERTs; recarregar a lista (várias RPCs) a cada
 * um derrubava a tela. O chat aberto continua recebendo tudo na hora.
 */
const JANELA_LISTA_MS = 1500;

/**
 * Um canal de realtime só para as tabelas do Docs. Os callbacks do chat aberto
 * ficam num ref para o canal não ser recriado a cada render (recriar fazia
 * perder INSERTs na janela de reinscrição).
 *
 *  - docs_mensagens INSERT → chat na hora + lista agrupada;
 *  - docs_mensagens UPDATE/DELETE → só o chat (recibo de entrega, download de
 *    mídia, edição: não mudam nada que a lista mostre);
 *  - docs_conversas * → lista agrupada. Dono/status mudam junto com um evento
 *    novo (assumiu, repassou...) e docs_eventos não está no realtime, então a
 *    recarga pega tudo sob ["docs"].
 */
export function useDocsRealtime(): React.MutableRefObject<DocsRealtimeCbs> {
  const queryClient = useQueryClient();
  const chatCbsRef = useRef<DocsRealtimeCbs>(CBS_VAZIOS);

  useEffect(() => {
    const lista = criarAgendador(() => {
      // cancelRefetch:false — num disparo em massa, cada tique cancelaria a
      // recarga anterior e a lista só atualizaria quando os eventos parassem.
      queryClient.invalidateQueries({ queryKey: ["docs"] }, { cancelRefetch: false });
      queryClient.invalidateQueries({ queryKey: ["docs-unread-total"] }, { cancelRefetch: false });
    }, JANELA_LISTA_MS);

    const canal = supabase
      .channel("docs-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "docs_mensagens" },
        (payload) => {
          const row = payload.new as { id?: string; conversa_id?: string } | null;
          if (row?.id && row.conversa_id) chatCbsRef.current.onInsert(row.id, row.conversa_id);
          lista.agendar();
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "docs_mensagens" },
        (payload) => {
          const row = payload.new as { id?: string; conversa_id?: string } | null;
          if (row?.id && row.conversa_id) chatCbsRef.current.onUpdate(row.id, row.conversa_id);
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "docs_mensagens" },
        (payload) => {
          // DELETE só traz a chave: é a duplicata do eco de uma edição.
          const row = payload.old as { id?: string } | null;
          if (row?.id) chatCbsRef.current.onDelete(row.id);
        },
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "docs_conversas" }, () =>
        lista.agendar(),
      )
      .subscribe();
    return () => {
      lista.cancelar();
      supabase.removeChannel(canal);
    };
  }, [queryClient]);

  return chatCbsRef;
}
