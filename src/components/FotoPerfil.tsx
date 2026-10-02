import type { ReactNode } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/**
 * Foto de perfil do WhatsApp (pessoa ou grupo) com fallback.
 * O link do WhatsApp expira: se a imagem falhar, o Radix mostra o fallback
 * (iniciais/ícone) sozinho, sem ícone de imagem quebrada.
 */
export function FotoPerfil({
  url,
  fallback,
  className,
}: {
  url: string | null | undefined;
  fallback: ReactNode;
  className?: string;
}) {
  return (
    <Avatar className={cn("h-10 w-10", className)}>
      {url ? (
        <AvatarImage src={url} alt="" referrerPolicy="no-referrer" className="object-cover" />
      ) : null}
      <AvatarFallback className="bg-accent text-sm font-medium text-primary">{fallback}</AvatarFallback>
    </Avatar>
  );
}
