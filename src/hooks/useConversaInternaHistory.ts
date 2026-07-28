import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  fetchMensagemInternaById,
  listMensagensInternasPage,
  type MensagemInterna,
} from "@/lib/internas-queries";
import { dedupeAndSortInternas } from "@/lib/internas-history";

/**
 * Histórico de UMA conversa interna: paginação infinita para cima, append em
 * tempo real e o contador de "novas abaixo".
 *
 * Espelha o useGrupoHistory, sem o handler de UPDATE: mensagem interna é
 * append-only (não há download de mídia nem status de envio para completar
 * depois), então a única mutação possível é INSERT.
 */

interface Params {
  conversaId: string | null;
  enabled: boolean;
}

interface Resultado {
  messages: MensagemInterna[];
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
  onRealtimeInsert: (messageId: string, conversaId: string) => void;
}

const PAGE_SIZE = 50;
const NEAR_BOTTOM_THRESHOLD_PX = 80;

export function useConversaInternaHistory({ conversaId, enabled }: Params): Resultado {
  const [messages, setMessages] = useState<MensagemInterna[]>([]);
  const [isLoadingInitial, setIsLoadingInitial] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [newBelow, setNewBelow] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const conversaIdRef = useRef<string | null>(conversaId);
  conversaIdRef.current = conversaId;
  const messagesRef = useRef<MensagemInterna[]>([]);
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

  // Carga inicial ao trocar de conversa.
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
        const { messages: inicial, hasMore: mais } = await listMensagensInternasPage({
          conversaId,
          limit: PAGE_SIZE,
        });
        if (cancelled) return;
        setMessages(inicial);
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
  }, [conversaId, enabled]);

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
      const { messages: antigas, hasMore: mais } = await listMensagensInternasPage({
        conversaId: conversa,
        beforeCreatedAt: maisAntiga,
        limit: PAGE_SIZE,
      });
      setMessages((prev) => dedupeAndSortInternas(prev, antigas));
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

  const onRealtimeInsert = useCallback(
    async (messageId: string, conversaDaMensagem: string) => {
      if (conversaDaMensagem !== conversaIdRef.current) return;
      if (messagesRef.current.some((m) => m.id === messageId)) return;
      const estavaNoFim = isNearBottom();
      try {
        const m = await fetchMensagemInternaById(messageId);
        if (!m) return;
        setMessages((prev) => dedupeAndSortInternas(prev, [m]));
        if (estavaNoFim) requestAnimationFrame(() => scrollToBottom(true));
        else setNewBelow((n) => n + 1);
      } catch {
        /* silencioso: realtime é best-effort */
      }
    },
    [scrollToBottom],
  );

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
    onRealtimeInsert,
  };
}
