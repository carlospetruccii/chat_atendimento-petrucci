import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { mesclarMensagens } from "@/lib/docs-logic";
import { type DocsMessage, fetchDocsMensagemById, listDocsMensagensPage } from "@/lib/docs-queries";

/**
 * Histórico de UMA conversa do Docs: paginação infinita para cima, append em
 * tempo real e o contador de "novas abaixo".
 *
 * Espelha o useGrupoHistory (conversa contínua, sem "ilhas" de atendimento) e
 * soma o que o Docs tem a mais: DELETE (a docs-acao remove a duplicata do eco
 * de uma edição) e `ingestMessage`, que põe na tela a bolha recém-enviada sem
 * esperar o eco do realtime.
 */

interface Params {
  conversaId: string | null;
  enabled: boolean;
}

interface Resultado {
  messages: DocsMessage[];
  isLoadingInitial: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  bottomRef: React.RefObject<HTMLDivElement | null>;
  scrollToBottom: (smooth?: boolean) => void;
  newBelow: number;
  clearNewBelow: () => void;
  retryInitial: () => void;
  ingestMessage: (messageId: string) => Promise<void>;
  onRealtimeInsert: (messageId: string, conversaId: string) => void;
  onRealtimeUpdate: (messageId: string, conversaId: string) => void;
  onRealtimeDelete: (messageId: string) => void;
}

const PAGE_SIZE = 50;
const NEAR_BOTTOM_THRESHOLD_PX = 80;

export function useDocsHistory({ conversaId, enabled }: Params): Resultado {
  const [messages, setMessages] = useState<DocsMessage[]>([]);
  const [isLoadingInitial, setIsLoadingInitial] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [newBelow, setNewBelow] = useState(0);
  const [tentativa, setTentativa] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const conversaIdRef = useRef<string | null>(conversaId);
  conversaIdRef.current = conversaId;
  const messagesRef = useRef<DocsMessage[]>([]);
  messagesRef.current = messages;
  const prependAdjustRef = useRef<{ prevHeight: number } | null>(null);

  const isNearBottom = (): boolean => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
  };

  const scrollToBottom = useCallback((smooth = false) => {
    bottomRef.current?.scrollIntoView({
      behavior: smooth ? "smooth" : "auto",
      block: "end",
    });
  }, []);

  const clearNewBelow = useCallback(() => setNewBelow(0), []);
  const retryInitial = useCallback(() => setTentativa((n) => n + 1), []);

  // Carga inicial ao trocar de conversa (ou ao pedir "Tentar novamente").
  useEffect(() => {
    if (!enabled || !conversaId) {
      setMessages([]);
      setHasMore(false);
      setIsLoadingInitial(false);
      return;
    }
    let cancelled = false;
    setIsLoadingInitial(true);
    setError(null);
    setMessages([]);
    setNewBelow(0);
    (async () => {
      try {
        const { messages: inicial, hasMore: mais } = await listDocsMensagensPage({
          conversaId,
          limit: PAGE_SIZE,
        });
        if (cancelled) return;
        // Mescla, não substitui: um INSERT do realtime que chegou enquanto a
        // página carregava já está na lista e não pode sumir.
        setMessages((prev) => mesclarMensagens(prev, inicial));
        setHasMore(mais);
        requestAnimationFrame(() => {
          if (!cancelled) scrollToBottom(false);
        });
      } catch (e) {
        if (!cancelled) setError(e as Error);
      } finally {
        if (!cancelled) setIsLoadingInitial(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversaId, enabled, tentativa]);

  // Mantém a posição visual ao prepend de página antiga.
  useLayoutEffect(() => {
    if (!prependAdjustRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) {
      prependAdjustRef.current = null;
      return;
    }
    const { prevHeight } = prependAdjustRef.current;
    el.scrollTop = el.scrollTop + (el.scrollHeight - prevHeight);
    prependAdjustRef.current = null;
  }, [messages]);

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    const conversa = conversaIdRef.current;
    const maisAntiga = messagesRef.current[0]?.createdAt;
    if (!conversa || !maisAntiga) return;
    setIsLoadingMore(true);
    try {
      const el = scrollContainerRef.current;
      prependAdjustRef.current = el ? { prevHeight: el.scrollHeight } : null;
      const { messages: antigas, hasMore: mais } = await listDocsMensagensPage({
        conversaId: conversa,
        beforeCreatedAt: maisAntiga,
        limit: PAGE_SIZE,
      });
      // Trocou de conversa no meio da busca: a página é de outra conversa.
      if (conversa !== conversaIdRef.current) return;
      setMessages((prev) => mesclarMensagens(prev, antigas));
      setHasMore(mais);
    } catch (e) {
      prependAdjustRef.current = null;
      setError(e as Error);
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, hasMore]);

  // Sentinela de topo → carrega a página anterior.
  useEffect(() => {
    if (!enabled) return;
    const sentinel = topSentinelRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { root, rootMargin: "200px 0px 0px 0px", threshold: 0 },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [enabled, loadMore, conversaId]);

  /** Busca a mensagem e junta na lista (sem rolar). null = não pertence mais aqui. */
  const buscarEJuntar = useCallback(async (messageId: string): Promise<DocsMessage | null> => {
    const m = await fetchDocsMensagemById(messageId);
    if (!m || m.conversaId !== conversaIdRef.current) return null;
    setMessages((prev) => mesclarMensagens(prev, [m]));
    return m;
  }, []);

  const ingestMessage = useCallback(
    async (messageId: string) => {
      try {
        const m = await buscarEJuntar(messageId);
        if (m) requestAnimationFrame(() => scrollToBottom(true));
      } catch {
        /* o eco do realtime ainda traz a bolha */
      }
    },
    [buscarEJuntar, scrollToBottom],
  );

  const onRealtimeInsert = useCallback(
    async (messageId: string, conversaDaMensagem: string) => {
      if (conversaDaMensagem !== conversaIdRef.current) return;
      if (messagesRef.current.some((m) => m.id === messageId)) return;
      const estavaNoFim = isNearBottom();
      try {
        const m = await buscarEJuntar(messageId);
        if (!m) return;
        if (estavaNoFim) requestAnimationFrame(() => scrollToBottom(true));
        else setNewBelow((n) => n + 1);
      } catch {
        /* silencioso: realtime é best-effort */
      }
    },
    [buscarEJuntar, scrollToBottom],
  );

  // UPDATE chega quando o download da mídia termina, o envio muda de status,
  // ou a mensagem é editada/apagada.
  const onRealtimeUpdate = useCallback(
    async (messageId: string, conversaDaMensagem: string) => {
      if (conversaDaMensagem !== conversaIdRef.current) return;
      if (!messagesRef.current.some((m) => m.id === messageId)) return;
      try {
        await buscarEJuntar(messageId);
      } catch {
        /* silencioso */
      }
    },
    [buscarEJuntar],
  );

  // DELETE só traz a chave primária: some da tela se estiver carregada.
  const onRealtimeDelete = useCallback((messageId: string) => {
    if (!messagesRef.current.some((m) => m.id === messageId)) return;
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }, []);

  return {
    messages,
    isLoadingInitial,
    isLoadingMore,
    hasMore,
    error,
    scrollContainerRef,
    topSentinelRef,
    bottomRef,
    scrollToBottom,
    newBelow,
    clearNewBelow,
    retryInitial,
    ingestMessage,
    onRealtimeInsert,
    onRealtimeUpdate,
    onRealtimeDelete,
  };
}
