import { useSignedMediaUrl } from "@/hooks/useSignedMediaUrl";
import { MediaLoading } from "./MediaLoading";
import { MediaError } from "./MediaError";

export function MediaVideo({
  storagePath,
  caption,
}: {
  storagePath: string;
  caption?: string | null;
}) {
  const { data: url, isLoading, error } = useSignedMediaUrl(storagePath);
  if (isLoading) return <MediaLoading tipo="video" />;
  if (error || !url) return <MediaError />;
  return (
    <div className="space-y-1">
      <video controls preload="metadata" src={url} className="max-h-72 rounded-md" />
      {caption && <p className="text-sm whitespace-pre-wrap break-words">{caption}</p>}
    </div>
  );
}
