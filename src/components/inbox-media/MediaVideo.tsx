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
  if (error || !url) return <MediaError tipo="video" />;
  return (
    <div className="space-y-1">
      {/* aspect-video + w-full: sem largura/altura conhecidas de antemão (o
          banco não guarda as dimensões do vídeo), a caixa reservada evita o
          chat pular quando o vídeo carrega. object-contain (não cover) porque
          vídeo vertical (gravado em pé, comum no WhatsApp) cortado por cover
          perderia a maior parte do quadro — aqui só sobra tarja preta.
          playsInline: sem isso o iOS abre o vídeo em tela cheia sozinho e tira
          o usuário do chat. preload="metadata" evita baixar o vídeo inteiro
          antes do usuário pedir play, importante em rede móvel. */}
      <video
        controls
        playsInline
        preload="metadata"
        src={url}
        className="aspect-video max-h-72 w-full max-w-full rounded-md bg-black object-contain"
      />
      {caption && <p className="text-sm whitespace-pre-wrap break-words">{caption}</p>}
    </div>
  );
}
