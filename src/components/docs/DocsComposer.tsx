import { useRef, useState } from "react";
import { Loader2, Mic, Send } from "lucide-react";
import { toast } from "sonner";
import { transcreverAudio } from "@/lib/ai-texto";
import { sendDocsAudio, sendDocsMedia, sendDocsTexto } from "@/lib/docs-acoes";
import type { DocsMessage } from "@/lib/docs-queries";
import { useTranscricaoPendente } from "@/hooks/useTranscricaoPendente";
import { useAudioRecorder, type RecordedAudio } from "@/hooks/useAudioRecorder";
import { QuotedMessagePreview } from "@/components/inbox/QuotedMessagePreview";
import { AudioRecorderBar } from "@/components/inbox/AudioRecorderBar";
import { AttachMenu, MAX_ATTACHMENT_BYTES, type PickedFile } from "@/components/inbox/AttachMenu";
import { EmojiPicker } from "@/components/inbox/EmojiPicker";
import { MediaPreviewDialog, type MediaTipo } from "@/components/inbox/MediaPreviewDialog";
import { SugestaoEnvioDialog } from "@/components/inbox/SugestaoEnvioDialog";
import {
  RichMessageComposer,
  type RichMessageComposerHandle,
} from "@/components/inbox/RichMessageComposer";

interface Props {
  conversaId: string;
  clienteNome: string;
  replyTo: DocsMessage | null;
  onCancelarResposta: () => void;
  autorDe: (m: DocsMessage) => string;
  /** Mensagem gravada: o pai põe a bolha na tela sem esperar o realtime. */
  onEnviada: (mensagemId: string | null) => void;
}

function tipoDoArquivo(file: File): MediaTipo {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "image";
  return "document";
}

/**
 * Composer do Docs — só aparece para o DONO da conversa (o pai decide). Mesmas
 * peças da Inbox e dos grupos: texto com formatação do WhatsApp e sugestão da
 * IA, emoji, anexo (colar imagem também), áudio gravado ou ditado. Tudo sai
 * pela docs-enviar, que usa o número financeiro. O pai remonta este componente
 * por conversa (key), então rascunho, anexo e gravação nunca vazam para outra.
 */
export function DocsComposer({
  conversaId,
  clienteNome,
  replyTo,
  onCancelarResposta,
  autorDe,
  onEnviada,
}: Props) {
  const composerRef = useRef<RichMessageComposerHandle>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingMedia, setPendingMedia] = useState<{ file: File; tipo: MediaTipo } | null>(null);
  const [recordedAudio, setRecordedAudio] = useState<RecordedAudio | null>(null);
  // Mensagem aguardando a sugestão otimizada da IA antes do envio.
  const [pendingOtimizacao, setPendingOtimizacao] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const setTranscricaoPendente = useTranscricaoPendente(composerRef);
  const recorder = useAudioRecorder();

  /** Executa um envio com o estado de "enviando" e o toast de erro padrão. */
  const enviar = async (tarefa: () => Promise<string | null>, depois: () => void) => {
    setSending(true);
    try {
      const id = await tarefa();
      depois();
      onEnviada(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível enviar.");
    } finally {
      setSending(false);
    }
  };

  // Enviar abre o diálogo de sugestão da IA; o envio de fato acontece em
  // doSend com o texto escolhido (sugestão, editada ou original).
  const handleSend = () => {
    const content = composerRef.current?.getMarkdownText().trim() ?? "";
    if (!content || sending) return;
    setPendingOtimizacao(content);
  };

  const doSend = (content: string) => {
    if (!content || sending) return;
    void enviar(
      () => sendDocsTexto({ conversaId, content, replyToMessageId: replyTo?.id ?? null }),
      () => {
        setPendingOtimizacao(null);
        composerRef.current?.clear();
        setHasDraft(false);
        onCancelarResposta();
        requestAnimationFrame(() => composerRef.current?.focus());
      },
    );
  };

  const handleSendMedia = (caption: string) => {
    if (!pendingMedia) return;
    const { file, tipo } = pendingMedia;
    void enviar(
      () =>
        sendDocsMedia({
          conversaId,
          tipo,
          file,
          caption,
          replyToMessageId: replyTo?.id ?? null,
        }),
      () => {
        setPendingMedia(null);
        onCancelarResposta();
      },
    );
  };

  const handleSendRecorded = () => {
    if (!recordedAudio || sending) return;
    const audio = recordedAudio;
    void enviar(
      () =>
        sendDocsAudio({
          conversaId,
          blob: audio.blob,
          mimeType: audio.mimeType,
          durationSeconds: audio.durationSeconds,
          replyToMessageId: replyTo?.id ?? null,
        }),
      () => {
        setRecordedAudio(null);
        onCancelarResposta();
      },
    );
  };

  // Alternativa ao envio do áudio: a IA transcreve e o texto cai no composer
  // para a pessoa revisar e mandar como texto.
  const handleTranscribeRecorded = async () => {
    if (!recordedAudio || transcribing) return;
    setTranscribing(true);
    try {
      const texto = await transcreverAudio(recordedAudio.blob, recordedAudio.mimeType, clienteNome);
      setRecordedAudio(null);
      setTranscricaoPendente(texto);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível transcrever o áudio.");
    } finally {
      setTranscribing(false);
    }
  };

  const handleAttachPick = (picked: PickedFile) => {
    setPendingMedia({ file: picked.file, tipo: tipoDoArquivo(picked.file) });
  };

  const handlePasteImage = (event: ClipboardEvent) => {
    if (sending) return;
    const item = Array.from(event.clipboardData?.items ?? []).find((it) =>
      it.type.startsWith("image/"),
    );
    const file = item?.getAsFile();
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

  const gravando = recorder.state !== "idle" || !!recordedAudio;

  return (
    <div className="space-y-2 bg-[var(--chat-bg)] px-4 pb-4 pt-2">
      {replyTo && !gravando && (
        <QuotedMessagePreview
          variant="compact"
          quoted={replyTo}
          authorLabel={autorDe(replyTo)}
          onClose={onCancelarResposta}
        />
      )}
      {gravando ? (
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
            placeholder="Digite uma mensagem..."
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
            className="touch-target-mobile inline-flex shrink-0 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50"
            aria-label="Gravar áudio"
          >
            <Mic className="h-5 w-5" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || !hasDraft}
            aria-label="Enviar mensagem"
            className="touch-target-mobile inline-flex shrink-0 items-center justify-center rounded-full bg-primary p-2 text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" strokeWidth={1.8} />
            )}
          </button>
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
    </div>
  );
}
