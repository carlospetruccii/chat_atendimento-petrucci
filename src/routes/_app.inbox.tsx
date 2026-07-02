import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Mic,
  Send,
  MessageCircle,
  ArrowRightLeft,
  CheckCircle2,
  Clock,
  Search,
  ArrowRightCircle,
  AlertCircle,
  UserPlus,
  Loader2,
  Reply,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  listInboxConversations,
  searchClientIdsByMessageContent,
  sendInboxMessage,
  sendInboxAudio,
  sendInboxMedia,
  listClientAtendimentosVisiveis,
  initialsOf,
  statusLabel,
  FALLBACK_DEPT_COR,
  type InboxConversation,
  type ClientAtendimentoSummary,
  type InboxMessage,
} from "@/lib/inbox-queries";
import { MessageMedia } from "@/components/inbox-media/MessageMedia";
import { ListaOpcoesPreview } from "@/components/inbox-media/ListaOpcoesPreview";
import { QuotedMessagePreview } from "@/components/inbox/QuotedMessagePreview";
import { useChatHistory } from "@/hooks/useChatHistory";
import { agruparMensagens, type AtendimentoMeta } from "@/lib/inbox-history";
import { ClientHistorySheet } from "@/components/inbox/ClientHistorySheet";
import { AudioRecorderBar } from "@/components/inbox/AudioRecorderBar";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import { AttachMenu, type PickedFile } from "@/components/inbox/AttachMenu";
import { MediaPreviewDialog, type MediaTipo } from "@/components/inbox/MediaPreviewDialog";
import { IniciarAtendimentoDialog } from "@/components/inbox/IniciarAtendimentoDialog";

interface InboxSearch {
  conversation?: string;
  mode?: "supervision";
}

export const Route = createFileRoute("/_app/inbox")({
  staticData: { title: "Inbox", noPadding: true },
  validateSearch: (search: Record<string, unknown>): InboxSearch => ({
    conversation: typeof search.conversation === "string" ? search.conversation : undefined,
    mode: search.mode === "supervision" ? "supervision" : undefined,
  }),
  component: InboxPage,
});

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  const isToday =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (isToday) {
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  if (
    d.getFullYear() === yest.getFullYear() &&
    d.getMonth() === yest.getMonth() &&
    d.getDate() === yest.getDate()
  ) {
    return "Ontem";
  }
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function deptStyle(cor: string | null | undefined): React.CSSProperties {
  const base = cor ?? FALLBACK_DEPT_COR;
  return {
    backgroundColor: `${base}1A`, // ~10% alpha
    color: base,
  };
}

function InboxPage() {
  const search = Route.useSearch();
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();

  const canViewAll = !!user && (user.isSuperadmin || user.permissions.includes("view_all_departments"));

  const [selected, setSelected] = useState<string | null>(search.conversation ?? null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const recorder = useAudioRecorder();
  const [recordedAudio, setRecordedAudio] = useState<
    import("@/hooks/useAudioRecorder").RecordedAudio | null
  >(null);
  const [pendingMedia, setPendingMedia] = useState<{ file: File; tipo: MediaTipo } | null>(null);
  const [repassarOpen, setRepassarOpen] = useState(false);
  const [encerrarOpen, setEncerrarOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [replyTo, setReplyTo] = useState<InboxMessage | null>(null);
  const [iniciarOpen, setIniciarOpen] = useState(false);

  // Limpa "responder" ao trocar de conversa.
  useEffect(() => {
    setReplyTo(null);
  }, [selected]);

  // Sincroniza ?conversation= com state
  useEffect(() => {
    if (search.conversation && search.conversation !== selected) {
      setSelected(search.conversation);
    }
  }, [search.conversation]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fecha a Linha do tempo ao trocar de conversa — só abre via botão.
  useEffect(() => {
    setTimelineOpen(false);
  }, [selected]);

  const conversationsQuery = useQuery({
    queryKey: ["inbox", "conversations", user?.id, canViewAll],
    queryFn: () =>
      listInboxConversations({
        userId: user!.id,
        isSuperadmin: user!.isSuperadmin,
        canViewAll,
      }),
    enabled: !!user,
  });

  const conversations = conversationsQuery.data ?? [];

  // Debounce do filtro para busca no banco
  const [debouncedFilter, setDebouncedFilter] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilter(filter.trim()), 300);
    return () => clearTimeout(t);
  }, [filter]);

  const messageSearchQuery = useQuery({
    queryKey: ["inbox", "search-msg", debouncedFilter],
    queryFn: () => searchClientIdsByMessageContent(debouncedFilter),
    enabled: debouncedFilter.length >= 2,
    staleTime: 30_000,
  });
  const matchedClientIds = messageSearchQuery.data ?? new Set<string>();

  const filtered = filter
    ? conversations.filter((c) => {
        const f = filter.toLowerCase();
        return (
          c.clientNome.toLowerCase().includes(f) ||
          c.clientNumero.includes(filter) ||
          matchedClientIds.has(c.clientId)
        );
      })
    : conversations;

  const current: InboxConversation | undefined =
    filtered.find((c) => c.id === selected) ??
    conversations.find((c) => c.id === selected);

  // Modo supervisão: Administrador abriu uma conversa que NÃO está atribuída a ela
  const supervisionMode = !!current && canViewAll && current.assignedTo !== user?.id;

  // Atendimentos do mesmo cliente que entram no scroll contínuo.
  const atendimentosQuery = useQuery({
    queryKey: [
      "inbox",
      "client-atendimentos",
      current?.clientId,
      current?.id,
      current?.departmentId,
      canViewAll,
    ],
    queryFn: () =>
      listClientAtendimentosVisiveis({
        clientId: current!.clientId,
        currentAtendimentoId: current!.id,
        currentDepartmentId: current!.departmentId,
        canViewAll,
      }),
    enabled: !!current,
  });

  const atendimentoMetas: AtendimentoMeta[] = useMemo(() => {
    const list = atendimentosQuery.data ?? [];
    const metas = list.map((a: ClientAtendimentoSummary) => ({
      id: a.id,
      status: a.status,
      createdAt: a.createdAt,
      closedAt: a.closedAt,
      isCurrent: a.id === current?.id,
    }));
    return metas;
  }, [atendimentosQuery.data, current?.id]);

  // IDs em ordem cronológica ASC (mais antigo primeiro).
  const atendimentoIds = useMemo(
    () =>
      [...atendimentoMetas]
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        .map((a) => a.id),
    [atendimentoMetas],
  );

  const chat = useChatHistory({
    atendimentoIds,
    enabled: !!current && atendimentoIds.length > 0,
  });

  const messagesById = useMemo(() => {
    const map = new Map<string, InboxMessage>();
    for (const m of chat.messages) map.set(m.id, m);
    return map;
  }, [chat.messages]);

  // Realtime: atualiza lista + injeta mensagens novas no chat ativo.
  // Mantém os callbacks num ref para não recriar o canal a cada render
  // (recriação rápida fazia o subscribe perder INSERTs durante a janela de re-inscrição).
  const chatCallbacksRef = useRef({
    onRealtimeInsert: chat.onRealtimeInsert,
    onRealtimeUpdate: chat.onRealtimeUpdate,
  });
  chatCallbacksRef.current = {
    onRealtimeInsert: chat.onRealtimeInsert,
    onRealtimeUpdate: chat.onRealtimeUpdate,
  };

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("inbox-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "mensagens" },
        (payload) => {
          const row = payload.new as { id?: string; atendimento_id?: string } | null;
          queryClient.invalidateQueries({ queryKey: ["inbox", "conversations"] });
          if (row?.id && row.atendimento_id) {
            chatCallbacksRef.current.onRealtimeInsert(row.id, row.atendimento_id);
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "mensagens" },
        (payload) => {
          const row = payload.new as { id?: string; atendimento_id?: string } | null;
          queryClient.invalidateQueries({ queryKey: ["inbox", "conversations"] });
          if (row?.id && row.atendimento_id) {
            chatCallbacksRef.current.onRealtimeUpdate(row.id, row.atendimento_id);
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "atendimentos" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["inbox", "conversations"] });
          queryClient.invalidateQueries({ queryKey: ["inbox", "client-atendimentos"] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, queryClient]);

  // A sessão é garantida pelo layout pai (_app.tsx); aqui ainda pode faltar o
  // PERFIL (users) por um instante — seguramos a tela até ele chegar, para que
  // o envio e as ações sempre carreguem a identidade de quem está logado.
  const chatItems = agruparMensagens(chat.messages, atendimentoMetas);

  if (!user) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }


  const handleSend = async () => {
    if (!current || !draft.trim()) return;
    setSending(true);
    try {
      await sendInboxMessage({
        atendimentoId: current.id,
        clientId: current.clientId,
        departmentId: current.departmentId,
        userId: user.id,
        content: draft.trim(),
        replyToMessageId: replyTo?.id ?? null,
      });
      setDraft("");
      setReplyTo(null);
      // Realtime já vai trazer; força scroll para o fim na próxima paint.
      requestAnimationFrame(() => chat.scrollToBottom(true));
    } catch (e) {
      toast.error("Não foi possível enviar a mensagem.");
      console.error(e);
    } finally {
      setSending(false);
    }
  };

  const handleStartRecording = async () => {
    try {
      await recorder.start();
    } catch {
      toast.error(recorder.error ?? "Não foi possível iniciar a gravação.");
    }
  };

  const handleStopRecording = async () => {
    const result = await recorder.finish();
    if (!result) {
      toast.error("Gravação vazia.");
      return;
    }
    setRecordedAudio(result);
  };

  const handleSendRecorded = async () => {
    if (!current || !recordedAudio) return;
    setSending(true);
    try {
      await sendInboxAudio({
        atendimentoId: current.id,
        blob: recordedAudio.blob,
        mimeType: recordedAudio.mimeType,
        durationSeconds: recordedAudio.durationSeconds,
        replyToMessageId: replyTo?.id ?? null,
      });
      setRecordedAudio(null);
      setReplyTo(null);
      requestAnimationFrame(() => chat.scrollToBottom(true));
    } catch (e) {
      toast.error("Não foi possível enviar o áudio.");
      console.error(e);
    } finally {
      setSending(false);
    }
  };

  const handleDeleteRecorded = () => setRecordedAudio(null);

  const handleCancelRecording = () => {
    recorder.cancel();
    setRecordedAudio(null);
  };

  const handleAttachPick = (picked: PickedFile) => {
    const tipo: MediaTipo = picked.file.type.startsWith("video/")
      ? "video"
      : picked.file.type.startsWith("image/")
        ? "image"
        : "document";
    setPendingMedia({ file: picked.file, tipo });
  };

  const handleSendMedia = async (caption: string) => {
    if (!current || !pendingMedia) return;
    setSending(true);
    try {
      await sendInboxMedia({
        atendimentoId: current.id,
        tipo: pendingMedia.tipo,
        file: pendingMedia.file,
        caption,
        replyToMessageId: replyTo?.id ?? null,
      });
      setPendingMedia(null);
      setReplyTo(null);
      requestAnimationFrame(() => chat.scrollToBottom(true));
    } catch (e) {
      toast.error("Não foi possível enviar o anexo.");
      console.error(e);
    } finally {
      setSending(false);
    }
  };
  const authorOf = (m: InboxMessage): string => {
    if (m.direction === "outbound") {
      if (m.senderType === "bot") return "Bot";
      if (m.senderType === "sistema") return "Sistema";
      if (m.senderType === "externo") return "Fora do sistema";
      return m.sentByUserId === user?.id ? "Você" : (m.sentByNome ?? "Atendente");
    }
    return current?.clientNome ?? "Cliente";
  };

  const assignToMe = async () => {

    if (!current) return;
    const { error } = await supabase
      .from("atendimentos")
      .update({
        assigned_to: user.id,
        status: "em_atendimento",
        assigned_at: new Date().toISOString(),
      })
      .eq("id", current.id);
    if (error) {
      toast.error("Não foi possível atribuir o atendimento.");
      return;
    }
    toast.success("Atendimento atribuído a você");
    queryClient.invalidateQueries({ queryKey: ["inbox"] });
  };

  return (
    <div className="h-full">
      <div className="flex h-full">
        {/* Lista */}
        <div className="w-[360px] shrink-0 border-r border-border bg-card overflow-y-auto">
          <div className="p-4 border-b border-border space-y-2">
            <button
              onClick={() => setIniciarOpen(true)}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <UserPlus className="h-4 w-4" strokeWidth={1.8} /> Iniciar atendimento
            </button>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              type="text"
              placeholder="Buscar conversas..."
              className="w-full rounded-2xl border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>

          {conversationsQuery.isLoading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando...
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              {canViewAll
                ? "Nenhuma conversa em andamento."
                : "Você não tem atendimentos ativos. Pegue um em Pendentes."}
            </div>
          ) : (
            <ul>
              {filtered.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => setSelected(c.id)}
                    className={`relative w-full text-left px-4 py-3 border-b border-border hover:bg-muted transition-colors ${
                      selected === c.id
                        ? "bg-[color-mix(in_oklab,var(--wa-green)_12%,transparent)] before:absolute before:left-0 before:top-0 before:h-full before:w-1 before:bg-primary"
                        : ""
                    }`}
                  >
                    <div className="flex gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-medium text-primary">
                        {initialsOf(c.clientNome)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-foreground truncate">
                            {c.clientNome}
                          </span>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {formatTime(c.lastMessageAt)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground truncate">
                          {c.lastMessagePreview || "—"}
                        </p>
                        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded"
                            style={deptStyle(c.departmentCor)}
                          >
                            {c.departmentNome ?? "Triagem"}
                          </span>
                          {c.status === "em_triagem" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                              {statusLabel(c.status)}
                            </span>
                          )}
                          {c.status === "encerrado" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-700">
                              {statusLabel(c.status)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Chat */}
        <div className="relative flex flex-1 flex-col bg-background">
          {!current ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="text-center">
                <MessageCircle
                  className="mx-auto h-12 w-12 text-muted-foreground"
                  strokeWidth={1.2}
                />
                <p className="mt-3 text-sm text-muted-foreground">Selecione uma conversa</p>
              </div>
            </div>
          ) : (
            <>
              {/* Cabeçalho */}
              <div className="flex items-center justify-between gap-3 border-b border-border bg-card px-6 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-medium text-primary">
                    {initialsOf(current.clientNome)}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground truncate">
                        {current.clientNome}
                      </span>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={deptStyle(current.departmentCor)}
                      >
                        {current.departmentNome ?? "Triagem"}
                      </span>
                      {current.status === "encerrado" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-700">
                          Encerrado
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{current.clientNumero}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {supervisionMode && current.status !== "em_triagem" && (
                    <Button
                      size="sm"
                      onClick={assignToMe}
                      className="bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      <UserPlus className="h-4 w-4" strokeWidth={1.5} />
                      Atribuir a mim
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRepassarOpen(true)}
                    className="rounded-2xl"
                  >
                    <ArrowRightLeft className="h-4 w-4" strokeWidth={1.5} />
                    Repassar
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEncerrarOpen(true)}
                    className="rounded-2xl"
                  >
                    <CheckCircle2 className="h-4 w-4" strokeWidth={1.5} />
                    Encerrar
                  </Button>
                  {canViewAll && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setTimelineOpen(true)}
                      className="rounded-2xl"
                    >
                      <Clock className="h-4 w-4" strokeWidth={1.5} />
                      Linha do tempo
                    </Button>
                  )}
                </div>
              </div>

              {/* Mensagens — scroll contínuo com paginação infinita pra cima */}
              <div
                ref={chat.scrollContainerRef}
                className="relative flex-1 overflow-y-auto p-6 bg-[var(--chat-bg)]"
              >
                {/* Sentinela de topo para IntersectionObserver */}
                <div ref={chat.topSentinelRef} aria-hidden className="h-px" />

                {chat.isLoadingMore && (
                  <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Carregando mais...
                  </div>
                )}

                {chat.isLoadingInitial ? (
                  <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando mensagens...
                  </div>
                ) : chatItems.length === 0 ? (
                  <div className="text-center py-12 text-sm text-muted-foreground">
                    Nenhuma mensagem nessa conversa ainda.
                  </div>
                ) : (
                  chatItems.map((item, idx) => {
                    if (item.kind === "date-separator") {
                      return (
                        <div key={item.key} className="flex justify-center my-3">
                          <span className="rounded-full bg-muted px-3 py-1 text-[11px] text-muted-foreground">
                            {item.label}
                          </span>
                        </div>
                      );
                    }
                    if (item.kind === "atendimento-separator") {
                      return (
                        <div
                          key={item.key}
                          data-atendimento-anchor={item.atendimentoId}
                          className="flex items-center gap-3 my-5"
                        >
                          <div className="flex-1 h-px bg-border" />
                          <span
                            className={`text-[11px] font-medium px-2.5 py-1 rounded-full border ${
                              item.isCurrent
                                ? "border-primary bg-muted text-primary"
                                : "border-border bg-card text-muted-foreground"
                            }`}
                          >
                            {item.label}
                          </span>
                          <div className="flex-1 h-px bg-border" />
                        </div>
                      );
                    }

                    const m = item.message;
                    const prevItem = idx > 0 ? chatItems[idx - 1] : null;
                    const prevMsg =
                      prevItem && prevItem.kind === "message" ? prevItem.message : null;
                    const sameSideAsPrev = prevMsg?.direction === m.direction;
                    const sameSenderAsPrev =
                      sameSideAsPrev &&
                      prevMsg?.senderType === m.senderType &&
                      prevMsg?.sentByUserId === m.sentByUserId;
                    const isMe = m.direction === "outbound";
                    const isExterno = m.senderType === "externo";
                    const isSticker = m.tipo === "sticker";
                    const anchor = item.isFirstOfAtendimento ? m.atendimentoId : undefined;

                    const bubbleColor = !isMe
                      ? "bg-[var(--chat-received)] text-[var(--chat-received-foreground)]"
                      : isExterno
                        ? "bg-primary/15 text-foreground border border-dashed border-primary"
                        : m.senderType === "sistema"
                          ? "bg-secondary text-secondary-foreground"
                          : "bg-[var(--chat-sent)] text-[var(--chat-sent-foreground)]";

                    const onPrimary = isMe && !isExterno && m.senderType !== "sistema";
                    const metaColor = onPrimary
                      ? "text-[var(--chat-sent-foreground)]/70"
                      : "text-muted-foreground";

                    const bubbleClass = isSticker
                      ? "max-w-[70%]"
                      : `min-w-fit max-w-[75ch] rounded-lg px-3 py-2 text-sm shadow-sm ${bubbleColor}`;

                    // Nome do remetente: somente Administrador enxerga (atendente comum nunca,
                    // nem o próprio nome — lado da bolha já indica autoria).
                    const showSenderName =
                      canViewAll &&
                      isMe &&
                      m.senderType === "atendente" &&
                      !sameSenderAsPrev &&
                      !!m.sentByNome;

                    const groupGap = idx === 0 ? "" : sameSideAsPrev ? "mt-1" : "mt-3";

                    const quoted = m.replyToMessageId
                      ? messagesById.get(m.replyToMessageId) ?? null
                      : null;

                    return (
                      <div
                        key={item.key}
                        data-atendimento-anchor={anchor}
                        data-message-id={m.id}
                        className={`group flex flex-col ${isMe ? "items-end" : "items-start"} ${groupGap}`}
                      >
                        {showSenderName && (
                          <span className="text-[11px] text-muted-foreground mb-0.5 px-1">
                            {m.sentByNome}
                          </span>
                        )}
                        <div className={`flex items-center gap-1 ${isMe ? "flex-row-reverse" : "flex-row"} max-w-[85%]`}>
                          <div className={bubbleClass}>
                            {m.replyToMessageId && (
                              <QuotedMessagePreview
                                variant="inBubble"
                                quoted={quoted}
                                authorLabel={quoted ? authorOf(quoted) : "Mensagem"}
                                onPrimary={onPrimary}
                                onClick={() => {
                                  if (!quoted) return;
                                  const el = document.querySelector(
                                    `[data-message-id="${quoted.id}"]`,
                                  );
                                  el?.scrollIntoView({ behavior: "smooth", block: "center" });
                                }}
                              />
                            )}
                            {m.tipo === "texto" ? (
                              (m.mediaMetadata as { kind?: string } | null)?.kind === "lista_opcoes" ? (
                                <ListaOpcoesPreview message={m} />
                              ) : (
                                <p className="whitespace-pre-wrap break-words">{m.content}</p>
                              )
                            ) : (
                              <MessageMedia message={m} />
                            )}
                          {isExterno && (
                            <p className={`text-[10px] italic ${metaColor} mt-1`}>
                              Enviado fora do sistema
                            </p>
                          )}
                            <span className={`block text-[10px] ${metaColor} mt-1 text-right`}>
                              {formatTime(m.createdAt)}
                              {m.senderType === "bot" && " · bot"}
                              {m.senderType === "sistema" && " · sistema"}
                            </span>
                          </div>
                          {!supervisionMode && (
                            <button
                              type="button"
                              onClick={() => setReplyTo(m)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                              aria-label="Responder mensagem"
                              title="Responder"
                            >
                              <Reply className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={chat.bottomRef} />

                {chat.newBelow > 0 && (
                  <button
                    onClick={() => {
                      chat.scrollToBottom(true);
                      chat.clearNewBelow();
                    }}
                    className="badge-counter absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full px-3 py-1.5 text-xs font-medium shadow-md"
                  >
                    ↓ {chat.newBelow} nova{chat.newBelow > 1 ? "s" : ""} mensage{chat.newBelow > 1 ? "ns" : "m"}
                  </button>
                )}
              </div>

              {/* Input */}
              {supervisionMode ? (
                <div className="flex items-center gap-2 border-t border-[var(--warning-border)] bg-[var(--warning-bg)] px-6 py-3 text-sm text-[var(--warning-foreground)]">
                  <AlertCircle className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                  <span>
                    Modo supervisão · Visualização. {current.status === "em_triagem"
                      ? "Atendimento ainda em triagem — aguarde classificação ou atribua manualmente em Pendentes."
                      : "Para enviar mensagens, atribua o atendimento a você."}
                  </span>
                </div>
              ) : (
                <div className="border-t border-border bg-card p-4 space-y-2">
                  {replyTo && recorder.state === "idle" && !recordedAudio && (
                    <QuotedMessagePreview
                      variant="compact"
                      quoted={replyTo}
                      authorLabel={authorOf(replyTo)}
                      onClose={() => setReplyTo(null)}
                    />
                  )}
                  {recorder.state !== "idle" || recordedAudio ? (
                    <AudioRecorderBar
                      state={recorder.state}
                      durationSeconds={recorder.durationSeconds}
                      maxSeconds={recorder.maxSeconds}
                      recorded={recordedAudio}
                      sending={sending}
                      onPause={recorder.pause}
                      onResume={recorder.resume}
                      onStop={handleStopRecording}
                      onCancel={handleCancelRecording}
                      onDelete={handleDeleteRecorded}
                      onSend={handleSendRecorded}
                    />
                  ) : (
                      <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
                        <AttachMenu
                          disabled={sending}
                          onPick={handleAttachPick}
                          onError={(msg) => toast.error(msg)}
                        />
                      <input
                        type="text"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                          }
                        }}
                        placeholder="Digite uma mensagem..."
                        className="flex-1 bg-transparent text-sm outline-none disabled:opacity-50"
                        disabled={sending}
                      />
                      <button
                        type="button"
                        onClick={handleStartRecording}
                        disabled={sending}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                        aria-label="Gravar áudio"
                      >
                        <Mic className="h-5 w-5" strokeWidth={1.5} />
                      </button>
                      <button
                        onClick={handleSend}
                        disabled={sending || !draft.trim()}
                        className="rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                      >
                        {sending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Send className="h-4 w-4" strokeWidth={1.8} />
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {canViewAll && (
                <ClientHistorySheet
                  open={timelineOpen}
                  onClose={() => setTimelineOpen(false)}
                  clientId={current.clientId}
                  clientNome={current.clientNome}
                  currentAtendimentoId={current.id}
                  currentDepartmentId={current.departmentId}
                  onPick={(id) => chat.scrollToAtendimento(id)}
                />
              )}
            </>
          )}
        </div>
      </div>

      <RepassarModal
        open={repassarOpen}
        onOpenChange={setRepassarOpen}
        atendimentoId={current?.id ?? null}
        onDone={() => {
          queryClient.invalidateQueries({ queryKey: ["inbox"] });
          setRepassarOpen(false);
        }}
      />
      <EncerrarModal
        open={encerrarOpen}
        onOpenChange={setEncerrarOpen}
        atendimentoId={current?.id ?? null}
        userId={user.id}
        onDone={() => {
          queryClient.invalidateQueries({ queryKey: ["inbox"] });
          setEncerrarOpen(false);
          setSelected(null);
        }}
      />
      <MediaPreviewDialog
        open={!!pendingMedia}
        file={pendingMedia?.file ?? null}
        tipo={pendingMedia?.tipo ?? "document"}
        sending={sending}
        onCancel={() => setPendingMedia(null)}
        onSend={handleSendMedia}
      />
      <IniciarAtendimentoDialog
        open={iniciarOpen}
        onOpenChange={setIniciarOpen}
        canChooseDept={canViewAll}
        onCreated={(atendimentoId) => {
          setIniciarOpen(false);
          setSelected(atendimentoId);
          queryClient.invalidateQueries({ queryKey: ["inbox-conversations"] });
        }}
      />
    </div>
  );
}

interface CollabRow {
  id: string;
  nome: string;
  department_id: string | null;
  departmentNome: string;
}

function RepassarModal({
  open,
  onOpenChange,
  atendimentoId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  atendimentoId: string | null;
  onDone: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [observacao, setObservacao] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { data: collabs } = useQuery({
    queryKey: ["collaborators-active"],
    queryFn: async (): Promise<CollabRow[]> => {
      const { data, error } = await supabase
        .from("users")
        .select("id, nome, department_id, ativo, is_system_user, departments:department_id(nome)")
        .eq("ativo", true)
        .eq("is_system_user", false)
        .order("nome");
      if (error) throw error;
      return (data ?? []).map((u) => ({
        id: u.id,
        nome: u.nome,
        department_id: u.department_id,
        departmentNome:
          (u.departments as { nome: string } | null)?.nome ?? "Sem departamento",
      }));
    },
    enabled: open,
  });

  const filtered = (collabs ?? []).filter((c) =>
    c.nome.toLowerCase().includes(search.toLowerCase()),
  );
  const grouped = useMemo(() => {
    const acc: Record<string, CollabRow[]> = {};
    for (const c of filtered) {
      (acc[c.departmentNome] ??= []).push(c);
    }
    return acc;
  }, [filtered]);
  const selectedUser = (collabs ?? []).find((c) => c.id === selected);

  const handleConfirm = async () => {
    if (!atendimentoId || !selectedUser) return;
    setSubmitting(true);

    const { data, error } = await supabase.rpc("repassar_atendimento", {
      p_atendimento_id: atendimentoId,
      p_to_user_id: selectedUser.id,
      p_observacao: observacao.trim() || undefined,
    });

    setSubmitting(false);

    if (error) {
      const code = (error as { code?: string }).code;
      if (code === "42501") {
        toast.error("Você não tem permissão para repassar este atendimento.");
      } else if (code === "P0002") {
        toast.error("Atendimento não está mais disponível para repasse.");
      } else if (code === "22023") {
        toast.error("Colaborador destino inválido.");
      } else {
        const msg = (error as { message?: string }).message;
        toast.error(msg ? `Não foi possível repassar: ${msg}` : "Não foi possível repassar o atendimento.");
      }
      return;
    }

    if (data === false) {
      toast.message("Atendimento já não pode mais ser repassado.");
      setObservacao("");
      onDone();
      return;
    }

    setObservacao("");
    toast.success(`Atendimento repassado para ${selectedUser.nome}`);
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Repassar atendimento</DialogTitle>
          <DialogDescription>
            Selecione o colaborador que deve assumir esta conversa.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar colaborador..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="max-h-64 overflow-y-auto -mx-1 px-1 space-y-3">
          {Object.entries(grouped).map(([dept, users]) => (
            <div key={dept}>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-1 mb-1">
                {dept}
              </div>
              <div className="space-y-1">
                {users.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => setSelected(u.id)}
                    className={`w-full flex items-center gap-3 rounded-md px-2 py-2 text-left transition-colors ${
                      selected === u.id ? "bg-accent" : "hover:bg-muted"
                    }`}
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-xs font-medium text-primary">
                      {initialsOf(u.nome)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-foreground">{u.nome}</div>
                      <div className="text-xs text-muted-foreground">{u.departmentNome}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <Textarea
          placeholder="Observação (opcional)"
          rows={2}
          value={observacao}
          onChange={(e) => setObservacao(e.target.value)}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!selectedUser || submitting} onClick={handleConfirm}>
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowRightCircle className="h-4 w-4" strokeWidth={1.5} />
            )}
            Confirmar repasse
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EncerrarModal({
  open,
  onOpenChange,
  atendimentoId,
  userId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  atendimentoId: string | null;
  userId: string;
  onDone: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [motivo, setMotivo] = useState("");

  // Reset motivo sempre que o modal fecha (cancelar, overlay, sucesso).
  useEffect(() => {
    if (!open) setMotivo("");
  }, [open]);

  const handleConfirm = async () => {
    if (!atendimentoId) return;
    setSubmitting(true);

    const { data, error } = await supabase.rpc("encerrar_atendimento", {
      p_atendimento_id: atendimentoId,
      p_motivo: motivo.trim() || undefined,
    });

    setSubmitting(false);

    if (error) {
      if (error.code === "42501") {
        toast.error("Você não tem permissão para encerrar este atendimento.");
      } else {
        toast.error("Não foi possível encerrar o atendimento.");
      }
      return;
    }

    if (data === false) {
      toast.message("Este atendimento já estava encerrado.");
      onDone();
      return;
    }

    toast.success("Atendimento encerrado");
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Encerrar atendimento</DialogTitle>
          <DialogDescription>
            Tem certeza que deseja encerrar este atendimento? Novas mensagens do cliente
            iniciarão um novo atendimento.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          placeholder="Motivo do encerramento (opcional)"
          rows={3}
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={submitting}
            className="bg-[#DC2626] text-white hover:bg-[#DC2626]/90"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Encerrar atendimento
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
