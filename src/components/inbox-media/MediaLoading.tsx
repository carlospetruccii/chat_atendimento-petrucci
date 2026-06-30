import { Image as ImageIcon, Mic, Video, FileText, Sticker, type LucideIcon } from "lucide-react";
import type { InboxMessage } from "@/lib/inbox-queries";

const ICON_BY_TIPO: Record<string, LucideIcon> = {
  imagem: ImageIcon,
  audio: Mic,
  video: Video,
  documento: FileText,
  sticker: Sticker,
};

export function MediaLoading({ tipo }: { tipo: InboxMessage["tipo"] }) {
  const Icon = ICON_BY_TIPO[tipo] ?? FileText;
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-3 animate-pulse">
      <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
      <span className="text-xs text-muted-foreground">Carregando mídia…</span>
    </div>
  );
}
