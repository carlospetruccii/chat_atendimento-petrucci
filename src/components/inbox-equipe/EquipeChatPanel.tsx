import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Mic, Send } from "lucide-react";
import { toast } from "sonner";
import {
  enviarMensagemInterna,
  enviarMidiaInterna,
  marcarConversaInternaLida,
  type ConversaInterna,
  type TipoMidiaInterna,
} from "@/lib/internas-queries";
import { agruparMensagensInternas, iniciaisDoNome } from "@/lib/internas-history";
import { useConversaInternaHistory } from "@/hooks/useConversaInternaHistory";
import { useAudioRecorder, type RecordedAudio } from "@/hooks/useAudioRecorder";
import { formatWhatsAppText } from "@/lib/whatsapp-format";
import { MessageMedia } from "@/components/inbox-media/MessageMedia";
import { AudioRecorderBar } from "@/components/inbox/AudioRecorderBar";
import { AttachMenu, MAX_ATTACHMENT_BYTES, type PickedFile } from "@/components/inbox/AttachMenu";
import { MediaPreviewDialog, type MediaTipo } from "@/components/inbox/MediaPreviewDialog";
import {
  RichMessageComposer,
  type RichMessageComposerHandle,
} from "@/components/inbox/RichMessageComposer";

interface Props {
  conversa: ConversaInterna;
  meuUserId: string;
  formatTime: (iso: string | null) => string;
  /** Entrega ao pai o callback de INSERT do canal Realtime (que vive lá). */
  registrarRealtime: (cbs: { onInsert: (messageId: string, conversaId: string) => void }) => void;
}

/**
 * A conversa interna aberta. Tem as mesmas funções do chat individual e do de
 * grupo — texto com formatação do WhatsApp, áudio gravado, imagem, vídeo,
 * documento, colar imagem, scroll infinito, tempo real, não lidas — e nada do
 * fluxo de atendimento (sem bot, triagem, departamento, repasse, encerramento).
 *
 * Não tem "responder mensagem": citação existe para conversa com muita gente
 * falando (grupo) ou histórico de ticket. Numa conversa entre duas pessoas o
 * contexto é a própria conversa.
 */
export function EquipeChatPanel({ conversa, meuUserId, formatTime, registrarRealtime }: Props) {
  const queryClient = useQueryClient();
  const composerRef = useRef<RichMessageComposerHandle>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingMedia, setPendingMedia] = useState<{ file: File; tipo: MediaTipo } | null>(null);
  const [recordedAudio, setRecordedAudio] = useState<RecordedAudio | null>(null);
  const recorder = useAudioRecorder();

  const chat = useConversaInternaHistory({ conversaId: conversa.id, enabled: true });

  // Limpa estado de composição ao trocar de conversa.
  useEffect(() => {
    setPendingMedia(null);
    setRecordedAudio(null);
  }, [conversa.id]);

  // O canal Realtime é do pai (um canal por aba, não um por conversa aberta).
  // Desregistra ao desmontar: sem isso, ao trocar de conversa o canal continuaria
  // chamando o callback da conversa ANTERIOR, num hook já desmontado.
  const registrarRef = useRef(registrarRealtime);
  registrarRef.current = registrarRealtime;
  useEffect(() => {
    registrarRef.current({ onInsert: chat.onRealtimeInsert });
    return () => registrarRef.current({ onInsert: () => {} });
  }, [chat.onRealtimeInsert]);

  // Zera o badge ao abrir e a cada mensagem nova enquanto a conversa está aberta.
  useEffect(() => {
    void marcarConversaInternaLida(conversa.id).then(() => {
      queryClient.invalidateQueries({ queryKey: ["internas", "conversas"] });
      queryClient.invalidateQueries({ queryKey: ["inbox", "abas-unread"] });
      queryClient.invalidateQueries({ queryKey: ["inbox-unread-total"] });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversa.id, chat.messages.length]);

  const invalidarLista = () => {
    queryClient.invalidateQueries({ queryKey: ["internas", "conversas"] });
  };

  const handleSend = async () => {
    const content = composerRef.current?.getMarkdownText().trim() ?? "";
    if (!content || sending) return;
    setSending(true);
    try {
      await enviarMensagemInterna({ conversaId: conversa.id, content });
      composerRef.current?.clear();
      setHasDraft(false);
      invalidarLista();
      requestAnimationFrame(() => {
        chat.scrollToBottom(true);
        composerRef.current?.focus();
      });
    } catch (e) {
      // O rascunho fica no composer de propósito: perder o texto digitado por
      // causa de uma falha de rede é pior do que ter que reenviar.
      toast.error(e instanceof Error ? e.message : "Não foi possível enviar a mensagem.");
    } finally {
      setSending(false);
    }
  };

  // O diálogo de prévia fala em inglês ("image"), o banco em português
  // ("imagem"). A tradução mora aqui, no ponto de contato entre os dois.
  const tipoParaBanco = (tipo: MediaTipo): TipoMidiaInterna =>
    tipo === "image" ? "imagem" : tipo === "video" ? "video" : "documento";

  const handleSendMedia = async (caption: string) => {
    if (!pendingMedia) return;
    setSending(true);
    try {
      await enviarMidiaInterna({
        conversaId: conversa.id,
        tipo: tipoParaBanco(pendingMedia.tipo),
        arquivo: pendingMedia.file,
        nomeArquivo: pendingMedia.file.name,
        caption,
      });
      setPendingMedia(null);
      invalidarLista();
      requestAnimationFrame(() => chat.scrollToBottom(true));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível enviar o anexo.");
    } finally {
      setSending(false);
    }
  };

  const handleSendRecorded = async () => {
    if (!recordedAudio) return;
    setSending(true);
    try {
      await enviarMidiaInterna({
        conversaId: conversa.id,
        tipo: "audio",
        arquivo: recordedAudio.blob,
        nomeArquivo: "audio.ogg",
        duracaoSegundos: recordedAudio.durationSeconds,
      });
      setRecordedAudio(null);
      invalidarLista();
      requestAnimationFrame(() => chat.scrollToBottom(true));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível enviar o áudio.");
    } finally {
      setSending(false);
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

  const primeiroNome = conversa.outroNome.split(" ")[0];
  const itens = agruparMensagensInternas(chat.messages, meuUserId);

  return (
    <>
      {/* Cabeçalho */}
      <div className="flex items-center gap-3 border-b border-border bg-card px-6 py-3">
        <span className="relative shrink-0">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-sm font-medium text-primary">
            {iniciaisDoNome(conversa.outroNome)}
          </span>
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card transition-colors ${
              conversa.outroDisponivel ? "bg-primary" : "bg-muted-foreground/40"
            }`}
            aria-hidden
          />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{conversa.outroNome}</p>
          <p className="truncate text-xs text-muted-foreground">
            {conversa.outroDepartmentNome ?? "Sem setor"}
            {" · "}
            {conversa.outroDisponivel ? "disponível" : "indisponível"}
          </p>
        </div>
        <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">
          conversa interna
        </span>
      </div>

      {/* Mensagens */}
      <div ref={chat.scrollContainerRef} className="flex-1 overflow-y-auto px-6 py-4">
        <div ref={chat.topSentinelRef} />
        {chat.isLoadingMore && (
          <div className="flex justify-center py-2">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {chat.isLoadingInitial ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando conversa...
          </div>
        ) : chat.error ? (
          <div className="py-12 text-center text-sm text-destructive">
            Não foi possível carregar as mensagens.
          </div>
        ) : itens.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Nenhuma mensagem ainda. Diga oi para {primeiroNome}.
          </div>
        ) : (
          itens.map((item) => {
            if (item.kind === "date-separator") {
              return (
                <div key={item.key} className="my-3 flex justify-center">
                  <span className="rounded-full bg-muted px-3 py-1 text-[11px] text-muted-foreground">
                    {item.label}
                  </span>
                </div>
              );
            }

            const m = item.message;
            return (
              <div
                key={item.key}
                data-message-id={m.id}
                className={`flex flex-col ${item.minha ? "items-end" : "items-start"} ${
                  item.colada ? "mt-1" : "mt-3"
                }`}
              >
                <div
                  className={`min-w-fit max-w-[75ch] rounded-lg px-3 py-2 text-sm shadow-sm ${
                    item.minha
                      ? "bg-[var(--chat-sent)] text-[var(--chat-sent-foreground)]"
                      : "bg-[var(--chat-received)] text-[var(--chat-received-foreground)]"
                  }`}
                >
                  {m.tipo === "texto" ? (
                    <p className="whitespace-pre-wrap break-words">
                      {formatWhatsAppText(m.content)}
                    </p>
                  ) : (
                    <MessageMedia message={m} />
                  )}
                  <span
                    className={`mt-1 block text-right text-[10px] ${
                      item.minha ? "text-[var(--chat-sent-foreground)]/70" : "text-muted-foreground"
                    }`}
                  >
                    {formatTime(m.createdAt)}
                  </span>
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
      <div className="border-t border-border bg-card p-4">
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
            onCancel={() => {
              recorder.cancel();
              setRecordedAudio(null);
            }}
            onDelete={() => setRecordedAudio(null)}
            onSend={handleSendRecorded}
          />
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
            <AttachMenu
              disabled={sending}
              onPick={handleAttachPick}
              onError={(msg) => toast.error(msg)}
            />
            <RichMessageComposer
              ref={composerRef}
              placeholder={`Mensagem para ${primeiroNome}...`}
              disabled={sending}
              onHasContentChange={setHasDraft}
              onPasteImage={handlePasteImage}
              onEnterSend={handleSend}
            />
            <button
              type="button"
              onClick={handleStartRecording}
              disabled={sending}
              className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              aria-label="Gravar áudio"
            >
              <Mic className="h-5 w-5" strokeWidth={1.5} />
            </button>
            <button
              onClick={handleSend}
              disabled={sending || !hasDraft}
              className="rounded-md bg-primary p-2 text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              aria-label="Enviar mensagem"
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

      <MediaPreviewDialog
        open={!!pendingMedia}
        file={pendingMedia?.file ?? null}
        tipo={pendingMedia?.tipo ?? "document"}
        sending={sending}
        onCancel={() => setPendingMedia(null)}
        onSend={handleSendMedia}
      />
    </>
  );
}
