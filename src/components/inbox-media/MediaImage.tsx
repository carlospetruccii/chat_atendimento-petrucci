import { useState } from "react";
import { useSignedMediaUrl } from "@/hooks/useSignedMediaUrl";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { MediaLoading } from "./MediaLoading";
import { MediaError } from "./MediaError";
import { ZoomableImage } from "./ZoomableImage";

export function MediaImage({ storagePath, caption }: { storagePath: string; caption?: string | null }) {
  const { data: url, isLoading, error } = useSignedMediaUrl(storagePath);
  const [open, setOpen] = useState(false);

  if (isLoading) return <MediaLoading tipo="imagem" />;
  if (error || !url) return <MediaError />;

  return (
    <div className="space-y-1">
      <button type="button" onClick={() => setOpen(true)} className="block">
        <img
          src={url}
          alt={caption ?? "Imagem"}
          className="max-h-64 rounded-md object-cover cursor-zoom-in"
        />
      </button>
      {caption && <p className="text-sm whitespace-pre-wrap break-words">{caption}</p>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] p-2 bg-black/95 border-none">
          <div className="h-[85vh] w-full">
            <ZoomableImage src={url} alt={caption ?? "Imagem"} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
