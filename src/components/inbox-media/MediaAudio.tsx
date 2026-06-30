import { useSignedMediaUrl } from "@/hooks/useSignedMediaUrl";
import { MediaLoading } from "./MediaLoading";
import { MediaError } from "./MediaError";

function formatDuration(seconds?: number | null): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function MediaAudio({
  storagePath,
  durationSeconds,
}: {
  storagePath: string;
  durationSeconds?: number | null;
}) {
  const { data: url, isLoading, error } = useSignedMediaUrl(storagePath);
  if (isLoading) return <MediaLoading tipo="audio" />;
  if (error || !url) return <MediaError />;
  const dur = formatDuration(durationSeconds);
  return (
    <div className="flex items-center gap-2 max-w-full">
      <audio controls preload="metadata" src={url} className="h-8 max-w-full" />
      {dur && <span className="text-[10px] text-muted-foreground">{dur}</span>}
    </div>
  );
}
