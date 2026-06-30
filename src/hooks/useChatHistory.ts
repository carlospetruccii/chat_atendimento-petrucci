import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  fetchMessageById,
  listInboxMessagesPage,
  listMessagesForAtendimento,
  type InboxMessage,
} from "@/lib/inbox-queries";

interface UseChatHistoryParams {
  atendimentoIds: string[];
  enabled: boolean;
}

interface UseChatHistoryResult {
  messages: InboxMessage[];
  isLoadingInitial: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  bottomRef: React.RefObject<HTMLDivElement | null>;
  scrollToAtendimento: (atendimentoId: string) => Promise<void>;
  scrollToBottom: (smooth?: boolean) => void;
  newBelow: number;
  clearNewBelow: () => void;
  onRealtimeInsert: (messageId: string, atendimentoId: string) => void;
  onRealtimeUpdate: (messageId: string, atendimentoId: string) => void;
}

const PAGE_SIZE = 50;
const NEAR_BOTTOM_THRESHOLD_PX = 80;

function dedupeAndSort(prev: InboxMessage[], incoming: InboxMessage[]): InboxMessage[] {
  if (incoming.length === 0) return prev;
  const map = new Map<string, InboxMessage>();
  for (const m of prev) map.set(m.id, m);
  for (const m of incoming) map.set(m.id, m);
  return Array.from(map.values()).sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
}

export function useChatHistory({
  atendimentoIds,
  enabled,
}: UseChatHistoryParams): UseChatHistoryResult {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [isLoadingInitial, setIsLoadingInitial] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [newBelow, setNewBelow] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Refs para coordenação entre callbacks e effects.
  const idsKey = atendimentoIds.join(",");
  const idsRef = useRef<string[]>(atendimentoIds);
  idsRef.current = atendimentoIds;
  const messagesRef = useRef<InboxMessage[]>([]);
  messagesRef.current = messages;
  const loadedIslandsRef = useRef<Set<string>>(new Set());
  const prependAdjustRef = useRef<{ prevHeight: number } | null>(null);

  const isNearBottom = (): boolean => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
  };

  const scrollToBottom = useCallback((smooth = false) => {
    const el = bottomRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "end" });
  }, []);

  const clearNewBelow = useCallback(() => setNewBelow(0), []);

  // Carga inicial sempre que muda o conjunto de atendimentos.
  useEffect(() => {
    if (!enabled || atendimentoIds.length === 0) {
      setMessages([]);
      setHasMore(false);
      setIsLoadingInitial(false);
      loadedIslandsRef.current = new Set();
      return;
    }
    let cancelled = false;
    setIsLoadingInitial(true);
    setError(null);
    setMessages([]);
    loadedIslandsRef.current = new Set();
    (async () => {
      try {
        const { messages: initial, hasMore } = await listInboxMessagesPage({
          atendimentoIds: idsRef.current,
          limit: PAGE_SIZE,
        });
        if (cancelled) return;
        setMessages(initial);
        setHasMore(hasMore);
        // Após paint, posiciona no fim.
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
  }, [idsKey, enabled]);

  // Mantém posição visual ao prepend de página antiga.
  useLayoutEffect(() => {
    if (!prependAdjustRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) {
      prependAdjustRef.current = null;
      return;
    }
    const { prevHeight } = prependAdjustRef.current;
    const delta = el.scrollHeight - prevHeight;
    el.scrollTop = el.scrollTop + delta;
    prependAdjustRef.current = null;
  }, [messages]);

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    const oldest = messagesRef.current[0]?.createdAt;
    if (!oldest) return;
    setIsLoadingMore(true);
    try {
      const el = scrollContainerRef.current;
      prependAdjustRef.current = el ? { prevHeight: el.scrollHeight } : null;
      const { messages: older, hasMore: more } = await listInboxMessagesPage({
        atendimentoIds: idsRef.current,
        beforeCreatedAt: oldest,
        limit: PAGE_SIZE,
      });
      setMessages((prev) => dedupeAndSort(prev, older));
      setHasMore(more);
    } catch (e) {
      prependAdjustRef.current = null;
      setError(e as Error);
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, hasMore]);

  // IntersectionObserver no topo.
  useEffect(() => {
    if (!enabled) return;
    const sentinel = topSentinelRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          loadMore();
        }
      },
      { root, rootMargin: "200px 0px 0px 0px", threshold: 0 },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [enabled, loadMore, idsKey]);

  // Carrega "ilha" de um atendimento inteiro (Linha do Tempo da Luana).
  const scrollToAtendimento = useCallback(async (atendimentoId: string) => {
    const ensureLoaded = async () => {
      if (loadedIslandsRef.current.has(atendimentoId)) return;
      // Já presente em messages? Marca como ilha e retorna.
      const present = messagesRef.current.some((m) => m.atendimentoId === atendimentoId);
      if (present) {
        loadedIslandsRef.current.add(atendimentoId);
        return;
      }
      const island = await listMessagesForAtendimento(atendimentoId);
      loadedIslandsRef.current.add(atendimentoId);
      // Ao inserir mensagens potencialmente mais antigas, mantém posição visual.
      const el = scrollContainerRef.current;
      prependAdjustRef.current = el ? { prevHeight: el.scrollHeight } : null;
      setMessages((prev) => dedupeAndSort(prev, island));
    };
    await ensureLoaded();
    // Aguarda paint para garantir que o anchor existe.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const root = scrollContainerRef.current;
    const anchor = root?.querySelector<HTMLElement>(
      `[data-atendimento-anchor="${atendimentoId}"]`,
    );
    if (anchor && root) {
      const offsetTop = anchor.offsetTop - root.offsetTop;
      root.scrollTo({ top: offsetTop - 16, behavior: "smooth" });
    }
  }, []);

  /**
   * Append vindo do realtime. Se a mensagem é de um atendimento que está em cena,
   * busca a versão hidratada (com sent_by) e adiciona; auto-scroll se já estava no fim.
   */
  const handleRealtimeInsert = useCallback(
    async (messageId: string, atendimentoId: string) => {
      if (!idsRef.current.includes(atendimentoId)) return;
      // Já está? Ignora.
      if (messagesRef.current.some((m) => m.id === messageId)) return;
      const wasNearBottom = isNearBottom();
      try {
        const m = await fetchMessageById(messageId);
        if (!m) return;
        setMessages((prev) => dedupeAndSort(prev, [m]));
        if (wasNearBottom) {
          requestAnimationFrame(() => scrollToBottom(true));
        } else {
          setNewBelow((n) => n + 1);
        }
      } catch {
        /* silencioso: realtime é best-effort */
      }
    },
    [scrollToBottom],
  );

  /**
   * Atualiza mensagens já renderizadas quando o backend completa o download da mídia
   * e grava `media_metadata.storage_path`.
   */
  const handleRealtimeUpdate = useCallback(async (messageId: string, atendimentoId: string) => {
    if (!idsRef.current.includes(atendimentoId)) return;
    if (!messagesRef.current.some((m) => m.id === messageId)) return;
    try {
      const m = await fetchMessageById(messageId);
      if (!m) return;
      setMessages((prev) => dedupeAndSort(prev, [m]));
    } catch {
      /* silencioso: realtime é best-effort */
    }
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
    scrollToAtendimento,
    scrollToBottom,
    newBelow,
    clearNewBelow,
    onRealtimeInsert: handleRealtimeInsert,
    onRealtimeUpdate: handleRealtimeUpdate,
  };
}
