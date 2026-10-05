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
  if (error || !url) return <MediaError tipo="imagem" />;

  return (
    <div className="space-y-1">
      <button type="button" onClick={() => setOpen(true)} className="block w-full max-w-full">
        {/* Proporção fixa 4:3 com corte (object-cover): o banco não guarda a
            largura/altura reais da foto, então sem uma caixa de tamanho
            conhecido de antemão o chat pula de posição quando a imagem termina
            de carregar (o scroll automático mira o fim errado). A foto
            original, sem corte, continua disponível no zoom ao tocar. */}
        <img
          src={url}
          alt={caption ?? "Imagem"}
          className="aspect-[4/3] max-h-80 w-full max-w-full rounded-md object-cover cursor-zoom-in"
        />
      </button>
      {caption && <p className="text-sm whitespace-pre-wrap break-words">{caption}</p>}
      <Dialog open={open} onOpenChange={setOpen}>
        {/* dvh, nunca vh: no celular a barra de endereço encolhe/expande a
            viewport visível, e vh não acompanha isso — sm:p-2 repete o p-2
            porque o Dialog base usa sm:p-6, que aqui devolveria a borda gorda
            do visualizador em telas ≥640px (o teste de 768px do briefing). */}
        <DialogContent className="max-w-[90vw] max-h-[90dvh] p-2 sm:p-2 bg-black/95 border-none">
          <div className="h-[85dvh] w-full">
            <ZoomableImage src={url} alt={caption ?? "Imagem"} fileName={storagePath.split("/").pop() ?? "imagem.jpg"} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
