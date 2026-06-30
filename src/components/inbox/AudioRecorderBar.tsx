import { useEffect, useState } from "react";
import { Send, Trash2, Loader2, Pause, Play, Square, Mic } from "lucide-react";
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
  onPause: () => void;
  onResume: () => void;
  onStop: () => void; // para gravação → vai para revisão
  onCancel: () => void; // descarta gravação em andamento
  onDelete: () => void; // descarta áudio gravado em revisão
  onSend: () => void;
}

export function AudioRecorderBar({
  state,
  durationSeconds,
  maxSeconds,
  recorded,
  sending,
  onPause,
  onResume,
  onStop,
  onCancel,
  onDelete,
  onSend,
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

  // Fase 3: revisão
  if (recorded) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2">
        <button
          type="button"
          onClick={onDelete}
          disabled={sending}
          className="text-muted-foreground hover:text-destructive disabled:opacity-50"
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
        <span className="text-xs text-muted-foreground font-mono tabular-nums">
          {fmt(recorded.durationSeconds)}
        </span>
        <button
          type="button"
          onClick={onSend}
          disabled={sending}
          className="rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          aria-label="Enviar áudio"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" strokeWidth={1.8} />}
        </button>
      </div>
    );
  }

  // Fases 1 e 2: gravando / pausado / encoding
  const isRecording = state === "recording";
  const isPaused = state === "paused";
  const isEncoding = state === "encoding";

  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2">
      <button
        type="button"
        onClick={onCancel}
        disabled={isEncoding}
        className="text-muted-foreground hover:text-destructive disabled:opacity-50"
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
          className="text-muted-foreground hover:text-foreground"
          aria-label="Pausar gravação"
        >
          <Pause className="h-5 w-5" strokeWidth={1.5} />
        </button>
      )}
      {isPaused && (
        <button
          type="button"
          onClick={onResume}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Retomar gravação"
        >
          <Play className="h-5 w-5" strokeWidth={1.5} />
        </button>
      )}

      <button
        type="button"
        onClick={onStop}
        disabled={isEncoding || durationSeconds < 1}
        className="rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
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
