import { X, Reply } from "lucide-react";
import type { MensagemRenderizavel } from "@/lib/mensagem-shape";

export function previewLabel(m: MensagemRenderizavel | null | undefined): string {
  if (!m) return "Mensagem";
  // Antes desta guarda, citar uma mensagem já apagada caía no fallback "Mensagem"
  // (o content foi esvaziado) e parecia um texto vazio qualquer — em vez de
  // deixar claro que aquele conteúdo não existe mais.
  if (m.apagadaEm) return "🚫 Mensagem apagada";
  switch (m.tipo) {
    case "texto":
      return m.content?.trim() || "Mensagem";
    case "imagem":
      return m.content?.trim() ? `📷 ${m.content.trim()}` : "📷 Imagem";
    case "video":
      return m.content?.trim() ? `🎥 ${m.content.trim()}` : "🎥 Vídeo";
    case "audio":
      return "🎤 Áudio";
    case "documento": {
      const fileName = (m.mediaMetadata?.file_name as string | undefined) ?? null;
      return fileName ? `📎 ${fileName}` : "📎 Documento";
    }
    case "sticker":
      return "Figurinha";
    case "localizacao":
      return "📍 Localização";
    case "contato":
      return "👤 Contato";
    default:
      return "Mensagem";
  }
}

interface Props {
  quoted: MensagemRenderizavel | null;
  /** Nome resolvido do remetente original (Você / nome do atendente / nome do cliente). */
  authorLabel?: string | null;
  variant?: "inBubble" | "compact";
  /** Cor de fundo claro/escuro: depende se a bolha pai é "primary" ou não. */
  onPrimary?: boolean;
  onClose?: () => void;
  onClick?: () => void;
}

export function QuotedMessagePreview({
  quoted,
  authorLabel,
  variant = "inBubble",
  onPrimary = false,
  onClose,
  onClick,
}: Props) {
  const label = previewLabel(quoted);
  const author = authorLabel ?? "Mensagem";

  if (variant === "compact") {
    return (
      <div className="flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted px-3 py-2 text-sm">
        <Reply className="h-4 w-4 mt-0.5 shrink-0 text-primary" strokeWidth={1.5} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-primary truncate">{author}</div>
          <div className="text-xs text-muted-foreground line-clamp-2 whitespace-pre-wrap break-words">
            {label}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
            aria-label="Cancelar resposta"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  // inBubble
  const bg = onPrimary ? "bg-primary-foreground/10" : "bg-foreground/5";
  const border = onPrimary ? "border-primary-foreground/40" : "border-primary/50";
  const subText = onPrimary ? "text-emerald-900/80" : "text-muted-foreground";
  const authorText = onPrimary ? "text-emerald-900" : "text-primary";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-1.5 flex w-full items-start gap-2 rounded border-l-2 ${border} ${bg} px-2 py-1.5 text-left transition hover:opacity-90`}
    >
      <div className="min-w-0 flex-1">
        <div className={`text-[11px] font-medium truncate ${authorText}`}>{author}</div>
        <div className={`text-xs line-clamp-2 whitespace-pre-wrap break-words ${subText}`}>
          {label}
        </div>
      </div>
    </button>
  );
}
