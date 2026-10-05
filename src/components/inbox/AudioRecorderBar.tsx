import { useEffect, useState } from "react";
import { Send, Trash2, Loader2, Pause, Play, Square, Mic, Sparkles } from "lucide-react";
import type { RecorderState, RecordedAudio } from "@/hooks/useAudioRecorder";

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

interface Props {
  state: RecorderState;
  durationSeconds: number;
  maxSeconds: number;
  recorded: RecordedAudio | null;
  sending: boolean;
  /** Transcrição da IA em andamento (loading no botão Transcrever). */
  transcribing: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void; // para gravação → vai para revisão
  onCancel: () => void; // descarta gravação em andamento
  onDelete: () => void; // descarta áudio gravado em revisão
  onSend: () => void; // envia o áudio como mensagem de voz
  /**
   * Transcreve o áudio em texto (IA) e joga no composer, sem enviar áudio.
   * Obrigatória de propósito: onSend e onTranscribe fazem coisas opostas, então
   * um chamador novo tem que declarar as duas em vez de herdar um default.
   */
  onTranscribe: () => void;
}

export function AudioRecorderBar({
  state,
  durationSeconds,
  maxSeconds,
  recorded,
  sending,
  transcribing,
  onPause,
  onResume,
  onStop,
  onCancel,
  onDelete,
  onSend,
  onTranscribe,
}: Props) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!recorded) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(recorded.blob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [recorded]);

  const maxLabel = `${Math.floor(maxSeconds / 60)}:${(maxSeconds % 60)
    .toString()
    .padStart(2, "0")}`;

  // Fase 3: revisão — a pessoa escolhe entre virar texto (IA) ou enviar o áudio.
  if (recorded) {
    const ocupado = sending || transcribing;
    return (
      <div className="flex items-center gap-2 rounded-3xl border border-border bg-background px-3 py-2 shadow-sm">
        <button
          type="button"
          onClick={onDelete}
          disabled={ocupado}
          className="touch-target-mobile inline-flex shrink-0 items-center justify-center text-muted-foreground hover:text-destructive disabled:opacity-50"
          aria-label="Apagar áudio"
        >
          <Trash2 className="h-5 w-5" strokeWidth={1.5} />
        </button>
        {previewUrl && (
          <audio
            controls
            src={previewUrl}
            preload="metadata"
            className="h-9 flex-1 min-w-0"
          />
        )}
        <span className="shrink-0 text-xs text-muted-foreground font-mono tabular-nums">
          {fmt(recorded.durationSeconds)}
        </span>
        <button
          type="button"
          onClick={onTranscribe}
          disabled={ocupado}
          // Rótulo some no celular: entre apagar, o player de áudio (que
          // precisa de espaço mínimo para os controles nativos) e enviar, o
          // texto "Transcrever" era o que sobrava para cortar numa tela de
          // 360px. O ícone + aria-label/title seguram o significado.
          className="touch-target-mobile flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-2 text-xs font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-50"
          aria-label="Transcrever em texto"
          title="A IA transcreve e corrige o que você falou; o texto vai para o campo de mensagem."
        >
          {transcribing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="hidden sm:inline">Transcrevendo…</span>
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" strokeWidth={1.8} />
              <span className="hidden sm:inline">Transcrever</span>
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onSend}
          disabled={ocupado}
          className="touch-target-mobile inline-flex shrink-0 items-center justify-center rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          aria-label="Enviar áudio"
          title="Envia a gravação como mensagem de voz."
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" strokeWidth={1.8} />
          )}
        </button>
      </div>
    );
  }

  // Fases 1 e 2: gravando / pausado / encoding
  const isRecording = state === "recording";
  const isPaused = state === "paused";
  const isEncoding = state === "encoding";

  return (
    <div className="flex items-center gap-3 rounded-3xl border border-border bg-background px-3 py-2 shadow-sm">
      <button
        type="button"
        onClick={onCancel}
        disabled={isEncoding}
        className="touch-target-mobile inline-flex shrink-0 items-center justify-center text-muted-foreground hover:text-destructive disabled:opacity-50"
        aria-label="Cancelar gravação"
      >
        <Trash2 className="h-5 w-5" strokeWidth={1.5} />
      </button>

      <div className="flex flex-1 items-center gap-2 text-sm">
        {isRecording && (
          <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
        )}
        {isPaused && (
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500" />
        )}
        <Mic className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
        <span className="font-mono tabular-nums text-foreground">
          {fmt(durationSeconds)}
        </span>
        <span className="text-xs text-muted-foreground">
          {isRecording
            ? `Gravando… (máx ${maxLabel})`
            : isPaused
              ? "Pausado"
              : "Processando…"}
        </span>
      </div>

      {isRecording && (
        <button
          type="button"
          onClick={onPause}
          className="touch-target-mobile inline-flex shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label="Pausar gravação"
        >
          <Pause className="h-5 w-5" strokeWidth={1.5} />
        </button>
      )}
      {isPaused && (
        <button
          type="button"
          onClick={onResume}
          className="touch-target-mobile inline-flex shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label="Retomar gravação"
        >
          <Play className="h-5 w-5" strokeWidth={1.5} />
        </button>
      )}

      <button
        type="button"
        onClick={onStop}
        disabled={isEncoding || durationSeconds < 1}
        className="touch-target-mobile inline-flex shrink-0 items-center justify-center rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
        aria-label="Parar gravação"
      >
        {isEncoding ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Square className="h-4 w-4 fill-current" strokeWidth={1.8} />
        )}
      </button>
    </div>
  );
}
