import { Image as ImageIcon, Mic, Video, FileText, Sticker, type LucideIcon } from "lucide-react";
import type { InboxMessage } from "@/lib/inbox-queries";

const ICON_BY_TIPO: Record<string, LucideIcon> = {
  imagem: ImageIcon,
  audio: Mic,
  video: Video,
  documento: FileText,
  sticker: Sticker,
};

// Cada esqueleto reserva ~o mesmo espaço que o estado final daquele tipo de
// mídia ocupa (ver MediaImage/MediaVideo/MediaSticker). Sem isso, quando a
// mídia termina de carregar o chat pula de posição: o esqueleto era uma
// pilulazinha de ~40px e o conteúdo real é uma caixa bem maior.
export function MediaLoading({ tipo }: { tipo: InboxMessage["tipo"] }) {
  const Icon = ICON_BY_TIPO[tipo] ?? FileText;

  if (tipo === "imagem") {
    return (
      <div className="flex aspect-[4/3] w-full max-w-full animate-pulse items-center justify-center rounded-md bg-muted">
        <Icon className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
      </div>
    );
  }

  if (tipo === "video") {
    return (
      <div className="flex aspect-video w-full max-w-full animate-pulse items-center justify-center rounded-md bg-muted">
        <Icon className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
      </div>
    );
  }

  if (tipo === "sticker") {
    return (
      <div className="flex h-32 w-32 animate-pulse items-center justify-center rounded-md bg-muted">
        <Icon className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
      </div>
    );
  }

  // audio / documento: mídia final é uma pilula compacta, o esqueleto já bate.
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-3 animate-pulse">
      <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
      <span className="text-xs text-muted-foreground">Carregando mídia…</span>
    </div>
  );
}
