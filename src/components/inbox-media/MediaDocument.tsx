import { useState } from "react";
import { FileText, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useSignedMediaUrl } from "@/hooks/useSignedMediaUrl";
import { MediaLoading } from "./MediaLoading";
import { MediaError } from "./MediaError";

function formatBytes(bytes?: number | null): string | null {
  if (!bytes || !Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MediaDocument({
  storagePath,
  fileName,
  sizeBytes,
  caption,
}: {
  storagePath: string;
  fileName?: string | null;
  sizeBytes?: number | null;
  caption?: string | null;
}) {
  const { data: url, isLoading, error } = useSignedMediaUrl(storagePath);
  const [downloading, setDownloading] = useState(false);

  if (isLoading) return <MediaLoading tipo="documento" />;
  if (error || !url) return <MediaError />;

  const size = formatBytes(sizeBytes);
  const displayName = fileName ?? "Documento";

  const openInNewTab = () => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (downloading) return;
    setDownloading(true);
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = displayName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // revoga após pequeno delay para o navegador concluir o download
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      toast.error("Não foi possível baixar o arquivo. Tente novamente.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 max-w-full">
      <div className="flex items-center gap-2 rounded-md bg-black/10 dark:bg-white/10 px-2 py-1.5 max-w-full">
        <button
          type="button"
          onClick={openInNewTab}
          className="flex items-center gap-2 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity cursor-pointer"
          aria-label={`Abrir ${displayName}`}
        >
          <FileText className="h-5 w-5 opacity-80 shrink-0" strokeWidth={1.5} />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium truncate">{displayName}</p>
            {size && <p className="text-[10px] opacity-70">{size}</p>}
          </div>
        </button>
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          className="opacity-80 hover:opacity-100 shrink-0 disabled:opacity-50"
          aria-label="Baixar"
        >
          {downloading ? (
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
          ) : (
            <Download className="h-4 w-4" strokeWidth={1.5} />
          )}
        </button>
      </div>
      {caption && <p className="text-sm whitespace-pre-wrap break-words">{caption}</p>}
    </div>
  );
}
