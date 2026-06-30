import { useSignedMediaUrl } from "@/hooks/useSignedMediaUrl";
import { MediaLoading } from "./MediaLoading";
import { MediaError } from "./MediaError";

export function MediaSticker({ storagePath }: { storagePath: string }) {
  const { data: url, isLoading, error } = useSignedMediaUrl(storagePath);
  if (isLoading) return <MediaLoading tipo="sticker" />;
  if (error || !url) return <MediaError />;
  return <img src={url} alt="Sticker" className="h-32 w-32 object-contain" />;
}
