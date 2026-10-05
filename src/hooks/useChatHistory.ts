import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  fetchMessageById,
  listInboxMessagesPage,
  listMessagesForAtendimento,
  type InboxMessage,
} from "@/lib/inbox-queries";

/** Altura do cabeçalho flutuante da conversa (pt-[5.25rem]) + folga. */
const ALTURA_CABECALHO_PX = 96;

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
  loadMoreError: Error | null;
  retryInitial: () => void;
  retryLoadMore: () => void;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  bottomRef: React.RefObject<HTMLDivElement | null>;
  scrollToAtendimento: (atendimentoId: string) => Promise<void>;
  scrollToBottom: (smooth?: boolean) => void;
  newBelow: number;
  clearNewBelow: () => void;
  /** Põe na tela uma mensagem que ESTE cliente acabou de gravar no banco. */
  ingestMessage: (messageId: string) => Promise<void>;
  onRealtimeInsert: (messageId: string, atendimentoId: string) => void;
  onRealtimeUpdate: (messageId: string, atendimentoId: string) => void;
  onRealtimeDelete: (messageId: string) => void;
}

const PAGE_SIZE = 50;
const NEAR_BOTTOM_THRESHOLD_PX = 80;

export function dedupeAndSort(prev: InboxMessage[], incoming: InboxMessage[]): InboxMessage[] {
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
  const [loadMoreError, setLoadMoreError] = useState<Error | null>(null);
  const [newBelow, setNewBelow] = useState(0);
  const [reloadGeneration, setReloadGeneration] = useState(0);

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
  const loadMoreBlockedRef = useRef(false);
  const historyGenerationRef = useRef(0);
  const loadMoreRequestRef = useRef(0);
  const loadMoreInFlightRef = useRef(false);

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
  const retryInitial = useCallback(() => setReloadGeneration((generation) => generation + 1), []);

  // Carga inicial sempre que muda o conjunto de atendimentos.
  useEffect(() => {
    const generation = ++historyGenerationRef.current;
    loadMoreRequestRef.current += 1;
    loadMoreInFlightRef.current = false;
    setIsLoadingMore(false);
    prependAdjustRef.current = null;

    if (!enabled || atendimentoIds.length === 0) {
      setMessages([]);
      setHasMore(false);
      setIsLoadingInitial(false);
      setError(null);
      setLoadMoreError(null);
      loadMoreBlockedRef.current = false;
      loadedIslandsRef.current = new Set();
      return;
    }
    let cancelled = false;
    setIsLoadingInitial(true);
    setError(null);
    setLoadMoreError(null);
    loadMoreBlockedRef.current = false;
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
      if (historyGenerationRef.current === generation) {
        historyGenerationRef.current += 1;
        loadMoreRequestRef.current += 1;
        loadMoreInFlightRef.current = false;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, enabled, reloadGeneration]);

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

  const loadMore = useCallback(
    async (force = false) => {
      if (loadMoreBlockedRef.current && !force) return;
      if (loadMoreInFlightRef.current || !hasMore) return;
      const oldest = messagesRef.current[0]?.createdAt;
      if (!oldest) return;

      const generation = historyGenerationRef.current;
      const requestId = ++loadMoreRequestRef.current;
      const atendimentoIdsSnapshot = [...idsRef.current];
      const requestIsCurrent = () =>
        generation === historyGenerationRef.current && requestId === loadMoreRequestRef.current;

      loadMoreInFlightRef.current = true;
      setIsLoadingMore(true);
      setLoadMoreError(null);
      loadMoreBlockedRef.current = false;
      try {
        const el = scrollContainerRef.current;
        prependAdjustRef.current = el ? { prevHeight: el.scrollHeight } : null;
        const { messages: older, hasMore: more } = await listInboxMessagesPage({
          atendimentoIds: atendimentoIdsSnapshot,
          beforeCreatedAt: oldest,
          limit: PAGE_SIZE,
        });
        if (!requestIsCurrent()) return;
        setMessages((prev) => dedupeAndSort(prev, older));
        setHasMore(more);
      } catch (e) {
        if (!requestIsCurrent()) return;
        prependAdjustRef.current = null;
        loadMoreBlockedRef.current = true;
        setLoadMoreError(e as Error);
      } finally {
        if (requestIsCurrent()) {
          loadMoreInFlightRef.current = false;
          setIsLoadingMore(false);
        }
      }
    },
    [hasMore],
  );

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

  // Carrega "ilha" de um atendimento inteiro (Linha do Tempo da Administrador).
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
    const anchor = root?.querySelector<HTMLElement>(`[data-atendimento-anchor="${atendimentoId}"]`);
    if (anchor && root) {
      // O cabeçalho da conversa flutua por cima do topo da lista (absolute),
      // então a âncora precisa parar abaixo dele, não colada na borda.
      root.scrollTo({ top: anchor.offsetTop - ALTURA_CABECALHO_PX, behavior: "smooth" });
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
   * Põe na tela uma mensagem que ESTE cliente acabou de gravar no banco.
   *
   * Existe porque o envio dependia 100% do evento de realtime voltar: `doSend`
   * inseria a linha e torcia para o INSERT chegar de volta. Quando não chegava
   * — ou chegava e era barrado pelo portão de `atendimentoIds`, ou apagado pela
   * sobrescrita da carga inicial — a mensagem só aparecia depois de recarregar,
   * embora já estivesse salva. Aqui o remetente não espera notícia de si mesmo.
   *
   * Não repete a checagem de `atendimentoIds` do caminho de realtime: a
   * mensagem é de quem está com a conversa aberta, por definição está em cena.
   *
   * O eco do realtime chega depois com o MESMO id; `dedupeAndSort` indexa por
   * id, então ele substitui a linha em vez de duplicá-la — e o próprio
   * `handleRealtimeInsert` já sai cedo quando o id está na lista.
   */
  const ingestMessage = useCallback(
    async (messageId: string) => {
      if (messagesRef.current.some((m) => m.id === messageId)) return;
      try {
        const m = await fetchMessageById(messageId);
        if (!m) return;
        setMessages((prev) => dedupeAndSort(prev, [m]));
        // Sempre rola: é a mensagem de quem está digitando, não de terceiro.
        requestAnimationFrame(() => scrollToBottom(true));
      } catch {
        // NUNCA propaga: quem chama está no try/catch do envio, e um erro aqui
        // faria a tela acusar "não foi possível enviar" para uma mensagem que
        // JÁ está gravada. Falhando aqui, sobra o eco do realtime.
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

  /**
   * Remove da tela uma mensagem que saiu do banco.
   *
   * DELETE em `mensagens` é raro (o trigger block_mensagem_delete só libera para
   * service_role), mas existe: ao editar, o eco da própria edição pode chegar
   * pelo webhook antes do UPDATE e criar uma linha duplicada, que a edge function
   * então remove. Sem este handler a bolha duplicada ficava na tela até a
   * conversa ser recarregada do zero, porque INSERT já a tinha pintado.
   *
   * Não filtra por atendimento: o payload de DELETE do Postgres só traz a chave
   * primária (replica identity default), então a checagem é "está na lista?".
   */
  const handleRealtimeDelete = useCallback((messageId: string) => {
    if (!messagesRef.current.some((m) => m.id === messageId)) return;
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }, []);

  return {
    messages,
    isLoadingInitial,
    isLoadingMore,
    hasMore,
    error,
    loadMoreError,
    retryInitial,
    retryLoadMore: () => void loadMore(true),
    scrollContainerRef,
    topSentinelRef,
    bottomRef,
    scrollToAtendimento,
    scrollToBottom,
    newBelow,
    clearNewBelow,
    ingestMessage,
    onRealtimeInsert: handleRealtimeInsert,
    onRealtimeUpdate: handleRealtimeUpdate,
    onRealtimeDelete: handleRealtimeDelete,
  };
}
