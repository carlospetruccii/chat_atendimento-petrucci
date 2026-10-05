import { useSignedMediaUrl } from "@/hooks/useSignedMediaUrl";
import { MediaLoading } from "./MediaLoading";
import { MediaError } from "./MediaError";

// 128px (h-32) confirmado como tamanho confortável em telas de 360px — é a
// mesma ordem de grandeza que o WhatsApp usa para figurinha, e como o valor é
// fixo por natureza (figurinha não tem "responsivo"), não há ajuste a fazer.
export function MediaSticker({ storagePath }: { storagePath: string }) {
  const { data: url, isLoading, error } = useSignedMediaUrl(storagePath);
  if (isLoading) return <MediaLoading tipo="sticker" />;
  if (error || !url) return <MediaError tipo="sticker" />;
  return <img src={url} alt="Sticker" className="h-32 w-32 object-contain" />;
}
