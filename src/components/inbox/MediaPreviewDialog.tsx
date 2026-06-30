import { useEffect, useMemo, useState } from "react";
import { FileText, Loader2, Send, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type MediaTipo = "image" | "video" | "document";

interface Props {
  open: boolean;
  file: File | null;
  tipo: MediaTipo;
  sending: boolean;
  onCancel: () => void;
  onSend: (caption: string) => void;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MediaPreviewDialog({
  open,
  file,
  tipo,
  sending,
  onCancel,
  onSend,
}: Props) {
  const [caption, setCaption] = useState("");

  const previewUrl = useMemo(() => {
    if (!file || tipo === "document") return null;
    return URL.createObjectURL(file);
  }, [file, tipo]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    if (!open) setCaption("");
  }, [open]);

  if (!file) return null;

  const showCaption = tipo !== "document" || true; // permite caption no document tb

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !sending) onCancel(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {tipo === "image" ? "Enviar imagem"
              : tipo === "video" ? "Enviar vídeo"
              : "Enviar documento"}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {tipo === "image" && previewUrl ? (
            <div className="flex items-center justify-center rounded-md bg-muted overflow-hidden max-h-[60vh]">
              <img
                src={previewUrl}
                alt={file.name}
                className="max-h-[60vh] w-auto object-contain"
              />
            </div>
          ) : tipo === "video" && previewUrl ? (
            <video
              src={previewUrl}
              controls
              className="max-h-[60vh] w-full rounded-md bg-black"
            />
          ) : (
            <div className="flex items-center gap-3 rounded-md border border-border bg-muted p-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-md bg-violet-500/15 text-violet-600 dark:text-violet-400">
                <FileText className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {file.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {humanSize(file.size)}
                </p>
              </div>
            </div>
          )}

          {(tipo === "image" || tipo === "video") && (
            <p className="text-xs text-muted-foreground truncate">
              {file.name} · {humanSize(file.size)}
            </p>
          )}

          {showCaption && (
            <Textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Adicione uma legenda (opcional)"
              rows={2}
              maxLength={1024}
              disabled={sending}
            />
          )}
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={sending}>
            <X className="h-4 w-4 mr-1" /> Cancelar
          </Button>
          <Button onClick={() => onSend(caption)} disabled={sending}>
            {sending ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Send className="h-4 w-4 mr-1" />
            )}
            Enviar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
