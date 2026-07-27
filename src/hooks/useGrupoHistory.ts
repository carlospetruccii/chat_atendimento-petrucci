import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  fetchGrupoMensagemById,
  type GrupoMessage,
  listGrupoMensagensPage,
} from "@/lib/grupos-queries";

/**
 * Histórico de mensagens de UM grupo: paginação infinita para cima, append em
 * tempo real e o contador de "novas abaixo".
 *
 * Espelha o useChatHistory do chat individual, sem o conceito de "ilhas" de
 * atendimento (grupo é uma conversa contínua, não uma sequência de tickets),
 * que é justamente o que torna aquele hook complicado.
 */

interface Params {
  grupoId: string | null;
  enabled: boolean;
}

interface Resultado {
  messages: GrupoMessage[];
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
  onRealtimeInsert: (messageId: string, grupoId: string) => void;
  onRealtimeUpdate: (messageId: string, grupoId: string) => void;
}

const PAGE_SIZE = 50;
const NEAR_BOTTOM_THRESHOLD_PX = 80;

function dedupeAndSort(prev: GrupoMessage[], incoming: GrupoMessage[]): GrupoMessage[] {
  if (incoming.length === 0) return prev;
  const map = new Map<string, GrupoMessage>();
  for (const m of prev) map.set(m.id, m);
  for (const m of incoming) map.set(m.id, m);
  return Array.from(map.values()).sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
}

export function useGrupoHistory({ grupoId, enabled }: Params): Resultado {
  const [messages, setMessages] = useState<GrupoMessage[]>([]);
  const [isLoadingInitial, setIsLoadingInitial] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [newBelow, setNewBelow] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const grupoIdRef = useRef<string | null>(grupoId);
  grupoIdRef.current = grupoId;
  const messagesRef = useRef<GrupoMessage[]>([]);
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

  // Carga inicial ao trocar de grupo.
  useEffect(() => {
    if (!enabled || !grupoId) {
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
        const { messages: inicial, hasMore: mais } = await listGrupoMensagensPage({
          grupoId,
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
  }, [grupoId, enabled]);

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
    const grupo = grupoIdRef.current;
    const maisAntiga = messagesRef.current[0]?.createdAt;
    if (!grupo || !maisAntiga) return;
    setIsLoadingMore(true);
    try {
      const el = scrollContainerRef.current;
      prependAdjustRef.current = el ? { prevHeight: el.scrollHeight } : null;
      const { messages: antigas, hasMore: mais } = await listGrupoMensagensPage({
        grupoId: grupo,
        beforeCreatedAt: maisAntiga,
        limit: PAGE_SIZE,
      });
      setMessages((prev) => dedupeAndSort(prev, antigas));
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
  }, [enabled, loadMore, grupoId]);

  const onRealtimeInsert = useCallback(
    async (messageId: string, grupoDaMensagem: string) => {
      if (grupoDaMensagem !== grupoIdRef.current) return;
      if (messagesRef.current.some((m) => m.id === messageId)) return;
      const estavaNoFim = isNearBottom();
      try {
        const m = await fetchGrupoMensagemById(messageId);
        if (!m) return;
        setMessages((prev) => dedupeAndSort(prev, [m]));
        if (estavaNoFim) requestAnimationFrame(() => scrollToBottom(true));
        else setNewBelow((n) => n + 1);
      } catch {
        /* silencioso: realtime é best-effort */
      }
    },
    [scrollToBottom],
  );

  // UPDATE chega quando o backend completa o download da mídia ou grava o
  // status do envio (enviando → enviado/falha).
  const onRealtimeUpdate = useCallback(async (messageId: string, grupoDaMensagem: string) => {
    if (grupoDaMensagem !== grupoIdRef.current) return;
    if (!messagesRef.current.some((m) => m.id === messageId)) return;
    try {
      const m = await fetchGrupoMensagemById(messageId);
      if (!m) return;
      setMessages((prev) => dedupeAndSort(prev, [m]));
    } catch {
      /* silencioso */
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
    scrollToBottom,
    newBelow,
    clearNewBelow,
    onRealtimeInsert,
    onRealtimeUpdate,
  };
}
