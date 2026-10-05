import { FotoPerfil } from "@/components/FotoPerfil";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ChevronLeft, Loader2, Mic, Reply, Send, Users } from "lucide-react";
import { GrupoParticipantesSheet } from "@/components/inbox-grupos/GrupoParticipantesSheet";
import { toast } from "sonner";
import { formatWhatsAppText } from "@/lib/whatsapp-format";
import { fetchContatoNamesByNumbers } from "@/lib/contatos-queries";
import {
  type Grupo,
  type GrupoMessage,
  marcarGrupoLido,
  marcarGrupoLidoNoWhatsapp,
  sendGrupoAudio,
  sendGrupoMedia,
  sendGrupoTexto,
} from "@/lib/grupos-queries";
import { SugestaoEnvioDialog } from "@/components/inbox/SugestaoEnvioDialog";
import { transcreverAudio } from "@/lib/ai-texto";
import { useTranscricaoPendente } from "@/hooks/useTranscricaoPendente";
import { agruparMensagensGrupo, autorDaMensagem, corDoParticipante } from "@/lib/grupos-history";
import { useGrupoHistory } from "@/hooks/useGrupoHistory";
import { useAudioRecorder, type RecordedAudio } from "@/hooks/useAudioRecorder";
import { MessageMedia } from "@/components/inbox-media/MessageMedia";
import { QuotedMessagePreview } from "@/components/inbox/QuotedMessagePreview";
import { AudioRecorderBar } from "@/components/inbox/AudioRecorderBar";
import { AttachMenu, MAX_ATTACHMENT_BYTES, type PickedFile } from "@/components/inbox/AttachMenu";
import { EmojiPicker } from "@/components/inbox/EmojiPicker";
import { MediaPreviewDialog, type MediaTipo } from "@/components/inbox/MediaPreviewDialog";
import {
  RichMessageComposer,
  type RichMessageComposerHandle,
} from "@/components/inbox/RichMessageComposer";

interface Props {
  grupo: Grupo;
  meuUserId: string;
  formatTime: (iso: string | null) => string;
  /** Volta para a lista no celular (o pai zera a seleção). Sem efeito no
   * desktop, onde lista e conversa convivem lado a lado. */
  onVoltar: () => void;
  /** Registra os callbacks de realtime do chat aberto (o canal vive na rota). */
  registrarRealtime: (cbs: {
    onInsert: (messageId: string, grupoId: string) => void;
    onUpdate: (messageId: string, grupoId: string) => void;
  }) => void;
}

/**
 * Chat de um grupo. Tem as mesmas funções do chat individual — texto com
 * formatação do WhatsApp, áudio, imagem/vídeo/documento, responder, colar
 * imagem, scroll infinito, tempo real, não lidas — e nada do fluxo de
 * atendimento: sem bot, triagem, departamento, repasse ou encerramento.
 */
export function GrupoChatPanel({
  grupo,
  meuUserId,
  formatTime,
  onVoltar,
  registrarRealtime,
}: Props) {
  const queryClient = useQueryClient();
  const composerRef = useRef<RichMessageComposerHandle>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<GrupoMessage | null>(null);
  const [pendingMedia, setPendingMedia] = useState<{ file: File; tipo: MediaTipo } | null>(null);
  const [recordedAudio, setRecordedAudio] = useState<RecordedAudio | null>(null);
  const [participantesOpen, setParticipantesOpen] = useState(false);
  // Mensagem aguardando a sugestão otimizada da IA antes do envio.
  const [pendingOtimizacao, setPendingOtimizacao] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const setTranscricaoPendente = useTranscricaoPendente(composerRef);
  // Grupo aberto AGORA — lido depois de awaits, onde o closure está velho.
  const grupoIdRef = useRef(grupo.id);
  grupoIdRef.current = grupo.id;
  const recorder = useAudioRecorder();

  const chat = useGrupoHistory({ grupoId: grupo.id, enabled: true });

  // Limpa estado de composição ao trocar de grupo.
  useEffect(() => {
    setReplyTo(null);
    setPendingMedia(null);
    setRecordedAudio(null);
    setPendingOtimizacao(null);
  }, [grupo.id]);

  // Entrega os callbacks de realtime para o canal único da rota (recriar canal
  // por grupo aberto fazia perder INSERTs na janela de reinscrição).
  const registrarRef = useRef(registrarRealtime);
  registrarRef.current = registrarRealtime;
  useEffect(() => {
    registrarRef.current({
      onInsert: chat.onRealtimeInsert,
      onUpdate: chat.onRealtimeUpdate,
    });
    // Desregistra ao desmontar: sem isso, ao fechar/trocar de grupo o canal
    // continuaria chamando os callbacks do grupo ANTERIOR (busca de mensagem
    // jogada fora, num hook já desmontado).
    return () => registrarRef.current({ onInsert: () => {}, onUpdate: () => {} });
  }, [chat.onRealtimeInsert, chat.onRealtimeUpdate]);

  // Badge interno: zera para quem abriu. "Tique azul" no WhatsApp: dispara ao
  // abrir e a cada mensagem nova enquanto a conversa está aberta (idempotente).
  useEffect(() => {
    void marcarGrupoLido(grupo.id).then(() => {
      queryClient.invalidateQueries({ queryKey: ["grupos", "lista"] });
      queryClient.invalidateQueries({ queryKey: ["inbox-unread-total"] });
      queryClient.invalidateQueries({ queryKey: ["inbox", "abas-unread"] });
    });
    void marcarGrupoLidoNoWhatsapp(grupo.id);
  }, [grupo.id, grupo.lastMessageAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nomes de contato dos participantes que aparecem na conversa carregada.
  const numerosVisiveis = useMemo(() => {
    const set = new Set<string>();
    for (const m of chat.messages) if (m.participanteNumero) set.add(m.participanteNumero);
    return Array.from(set).sort();
  }, [chat.messages]);

  const nomesQuery = useQuery({
    queryKey: ["grupos", "contato-nomes", numerosVisiveis],
    queryFn: () => fetchContatoNamesByNumbers(numerosVisiveis),
    enabled: numerosVisiveis.length > 0,
    staleTime: 5 * 60_000,
  });
  const nomesDeContato = nomesQuery.data ?? new Map<string, string>();

  const autorDe = (m: GrupoMessage): string => autorDaMensagem(m, { meuUserId, nomesDeContato });

  const mensagensPorId = useMemo(() => {
    const map = new Map<string, GrupoMessage>();
    for (const m of chat.messages) map.set(m.id, m);
    return map;
  }, [chat.messages]);

  const itens = agruparMensagensGrupo(chat.messages);

  // Grupo em modo "somente admins" e não somos admin: o envio falharia na
  // uazapi, então bloqueamos aqui e explicamos.
  const somenteLeitura = grupo.somenteAdminEnvia && !grupo.souAdmin;

  // Enviar abre o diálogo de sugestão da IA; o envio de fato acontece em
  // doSend com o texto escolhido (sugestão, editada ou original).
  const handleSend = () => {
    const content = composerRef.current?.getMarkdownText().trim() ?? "";
    if (!content || sending) return;
    setPendingOtimizacao(content);
  };

  const doSend = async (content: string) => {
    if (!content || sending) return;
    setSending(true);
    try {
      await sendGrupoTexto({
        grupoId: grupo.id,
        content,
        replyToMessageId: replyTo?.id ?? null,
      });
      setPendingOtimizacao(null);
      composerRef.current?.clear();
      setHasDraft(false);
      setReplyTo(null);
      requestAnimationFrame(() => {
        chat.scrollToBottom(true);
        composerRef.current?.focus();
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível enviar a mensagem.");
    } finally {
      setSending(false);
    }
  };

  const handleSendMedia = async (caption: string) => {
    if (!pendingMedia) return;
    setSending(true);
    try {
      await sendGrupoMedia({
        grupoId: grupo.id,
        tipo: pendingMedia.tipo,
        file: pendingMedia.file,
        caption,
        replyToMessageId: replyTo?.id ?? null,
      });
      setPendingMedia(null);
      setReplyTo(null);
      requestAnimationFrame(() => chat.scrollToBottom(true));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível enviar o anexo.");
    } finally {
      setSending(false);
    }
  };

  const handleSendRecorded = async () => {
    if (!recordedAudio || sending) return;
    setSending(true);
    try {
      await sendGrupoAudio({
        grupoId: grupo.id,
        blob: recordedAudio.blob,
        mimeType: recordedAudio.mimeType,
        durationSeconds: recordedAudio.durationSeconds,
        replyToMessageId: replyTo?.id ?? null,
      });
      setRecordedAudio(null);
      setReplyTo(null);
      requestAnimationFrame(() => chat.scrollToBottom(true));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível enviar o áudio.");
    } finally {
      setSending(false);
    }
  };

  // Alternativa ao envio do áudio: a IA transcreve/corrige e o texto cai no
  // composer para a pessoa revisar e enviar como mensagem de texto.
  const handleTranscribeRecorded = async () => {
    if (!recordedAudio || transcribing) return;
    const grupoDaGravacao = grupo.id;
    setTranscribing(true);
    try {
      const texto = await transcreverAudio(recordedAudio.blob, recordedAudio.mimeType);
      // Trocou de grupo enquanto a IA respondia: descarta em vez de jogar o
      // texto ditado no composer de outro grupo.
      if (grupoDaGravacao !== grupoIdRef.current) return;
      setRecordedAudio(null);
      setTranscricaoPendente(texto);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível transcrever o áudio.");
    } finally {
      setTranscribing(false);
    }
  };

  const handleAttachPick = (picked: PickedFile) => {
    const tipo: MediaTipo = picked.file.type.startsWith("video/")
      ? "video"
      : picked.file.type.startsWith("image/")
        ? "image"
        : "document";
    setPendingMedia({ file: picked.file, tipo });
  };

  const handlePasteImage = (event: ClipboardEvent) => {
    if (sending) return;
    const item = Array.from(event.clipboardData?.items ?? []).find((it) =>
      it.type.startsWith("image/"),
    );
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error("Arquivo muito grande (máx 16 MB).");
      return;
    }
    handleAttachPick({ file, kind: "media" });
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

  return (
    <>
      {/* Cabeçalho */}
      <div className="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {/* Só existe no celular: sem ele quem abre um grupo fica preso na
              conversa, porque lista e conversa não convivem em telas estreitas. */}
          <button
            type="button"
            onClick={onVoltar}
            aria-label="Voltar para a lista de grupos"
            className="touch-target-mobile -ml-1 flex shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-primary md:hidden"
          >
            <ChevronLeft className="h-5 w-5" strokeWidth={1.8} />
          </button>
          <FotoPerfil
            url={grupo.fotoUrl}
            fallback={<Users className="h-4 w-4" strokeWidth={1.8} />}
            className="h-9 w-9 shrink-0"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-foreground truncate">{grupo.nome}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                grupo
              </span>
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {grupo.participantesTotal !== null
                ? `${grupo.participantesTotal} participantes`
                : "Participantes não sincronizados"}
              {grupo.topico ? ` · ${grupo.topico}` : ""}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setParticipantesOpen(true)}
          title="Ver participantes"
          aria-label="Ver participantes"
          className="touch-target-mobile flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
        >
          <Users className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>

      <GrupoParticipantesSheet
        grupoId={grupo.id}
        grupoNome={grupo.nome}
        open={participantesOpen}
        onOpenChange={setParticipantesOpen}
      />

      {/* Mensagens */}
      <div
        ref={chat.scrollContainerRef}
        className="scroll-contain relative flex-1 overflow-y-auto bg-[var(--chat-bg)] p-3 sm:p-6"
      >
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
        ) : itens.length === 0 ? (
          <div className="text-center py-12 text-sm text-muted-foreground">
            Nenhuma mensagem neste grupo ainda.
          </div>
        ) : (
          itens.map((item) => {
            if (item.kind === "date-separator") {
              return (
                <div key={item.key} className="flex justify-center my-3">
                  <span className="rounded-full bg-muted px-3 py-1 text-[11px] text-muted-foreground">
                    {item.label}
                  </span>
                </div>
              );
            }

            const m = item.message;
            const isMe = m.direction === "outbound";
            const isExterno = m.senderType === "externo";
            const isSticker = m.tipo === "sticker";
            const falhou = m.statusEnvio === "falha";

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

            // min-w-0 (em vez de min-w-fit): a bolha pode encolher abaixo do
            // conteúdo quando precisa. Sem isso ela força rolagem horizontal no
            // celular antes de dar ao texto a chance de quebrar linha.
            const bubbleClass = isSticker
              ? "max-w-[70%]"
              : `min-w-0 max-w-[75ch] rounded-lg px-3 py-2 text-sm shadow-sm ${bubbleColor}`;

            // Em grupo o nome do autor é essencial: várias pessoas falando.
            // Cor estável por participante (derivada do número), estilo WhatsApp.
            const autor = autorDe(m);
            const corAutor = isMe
              ? undefined
              : corDoParticipante(m.participanteNumero ?? m.participanteNome);

            const quoted = m.replyToMessageId
              ? (mensagensPorId.get(m.replyToMessageId) ?? null)
              : null;

            return (
              <div
                key={item.key}
                data-message-id={m.id}
                className={`group flex flex-col ${isMe ? "items-end" : "items-start"} ${
                  item.colada ? "mt-1" : "mt-3"
                }`}
              >
                {item.mostrarAutor && (
                  // min-w-0 + truncate: o nome do participante pode chegar sem
                  // espaços (pushname comprido do WhatsApp) e, sem isso, esticava
                  // a bolha para fora da tela no celular em vez de cortar com "...".
                  <span
                    className="mb-0.5 min-w-0 max-w-[85%] truncate px-1 text-[11px] font-medium"
                    style={corAutor ? { color: corAutor } : undefined}
                  >
                    {autor}
                  </span>
                )}
                <div
                  className={`flex items-center gap-1 ${
                    isMe ? "flex-row-reverse" : "flex-row"
                  } max-w-[85%]`}
                >
                  <div className={bubbleClass}>
                    {m.replyToMessageId && (
                      <QuotedMessagePreview
                        variant="inBubble"
                        quoted={quoted}
                        authorLabel={quoted ? autorDe(quoted) : "Mensagem"}
                        onPrimary={onPrimary}
                        onClick={() => {
                          if (!quoted) return;
                          document
                            .querySelector(`[data-message-id="${quoted.id}"]`)
                            ?.scrollIntoView({ behavior: "smooth", block: "center" });
                        }}
                      />
                    )}
                    {m.tipo === "texto" ? (
                      <p className="whitespace-pre-wrap break-anywhere">
                        {formatWhatsAppText(m.content)}
                      </p>
                    ) : (
                      <MessageMedia message={m} escopo="grupo" />
                    )}
                    {isExterno && (
                      <p className={`text-[10px] italic ${metaColor} mt-1`}>
                        Enviado fora do sistema
                      </p>
                    )}
                    <span className={`block text-[10px] ${metaColor} mt-1 text-right`}>
                      {formatTime(m.createdAt)}
                      {m.senderType === "sistema" && " · sistema"}
                      {m.statusEnvio === "enviando" && " · enviando"}
                    </span>
                    {falhou && (
                      <p className="mt-1 flex items-center gap-1 text-[10px] text-destructive">
                        <AlertCircle className="h-3 w-3" strokeWidth={2} />
                        Não enviada
                      </p>
                    )}
                  </div>
                  {!somenteLeitura && (
                    // No celular não existe "passar o mouse": o botão fica
                    // sempre visível (com alvo de toque maior). No desktop volta
                    // a só aparecer com hover, como antes.
                    <button
                      type="button"
                      onClick={() => setReplyTo(m)}
                      className="touch-target-mobile inline-flex shrink-0 items-center justify-center rounded-full p-1.5 text-muted-foreground opacity-100 transition-opacity hover:bg-muted hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
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
            ↓ {chat.newBelow} nova{chat.newBelow > 1 ? "s" : ""} mensage
            {chat.newBelow > 1 ? "ns" : "m"}
          </button>
        )}
      </div>

      {/* Composer */}
      {somenteLeitura ? (
        <div className="flex items-center gap-2 border-t border-[var(--warning-border)] bg-[var(--warning-bg)] px-4 py-3 text-sm text-[var(--warning-foreground)] sm:px-6">
          <AlertCircle className="h-4 w-4 shrink-0" strokeWidth={1.5} />
          <span>
            Este grupo permite mensagens apenas de administradores e nosso número não é
            administrador. Você pode ler, mas não enviar.
          </span>
        </div>
      ) : (
        <div className="bg-[var(--chat-bg)] px-4 pb-4 pt-2 space-y-2">
          {replyTo && recorder.state === "idle" && !recordedAudio && (
            <QuotedMessagePreview
              variant="compact"
              quoted={replyTo}
              authorLabel={autorDe(replyTo)}
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
              transcribing={transcribing}
              onPause={recorder.pause}
              onResume={recorder.resume}
              onStop={handleStopRecording}
              onCancel={() => {
                recorder.cancel();
                setRecordedAudio(null);
              }}
              onDelete={() => setRecordedAudio(null)}
              onSend={handleSendRecorded}
              onTranscribe={handleTranscribeRecorded}
            />
          ) : (
            <div className="flex items-center gap-2 rounded-3xl border border-border bg-background px-3 py-2 shadow-sm">
              <AttachMenu
                disabled={sending}
                onPick={handleAttachPick}
                onError={(msg) => toast.error(msg)}
              />
              <RichMessageComposer
                ref={composerRef}
                placeholder="Mensagem para o grupo..."
                disabled={sending}
                onHasContentChange={setHasDraft}
                onPasteImage={handlePasteImage}
                onEnterSend={handleSend}
              />
              <EmojiPicker
                disabled={sending}
                onPick={(char) => composerRef.current?.insertText(char)}
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
                disabled={sending || !hasDraft}
                aria-label="Enviar mensagem"
                className="touch-target-mobile inline-flex items-center justify-center rounded-full bg-primary p-2 text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
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

      <MediaPreviewDialog
        open={!!pendingMedia}
        file={pendingMedia?.file ?? null}
        tipo={pendingMedia?.tipo ?? "document"}
        sending={sending}
        onCancel={() => setPendingMedia(null)}
        onSend={handleSendMedia}
      />
      <SugestaoEnvioDialog
        original={pendingOtimizacao}
        enviando={sending}
        onCancelar={() => {
          setPendingOtimizacao(null);
          composerRef.current?.focus();
        }}
        onEnviar={doSend}
      />
    </>
  );
}
