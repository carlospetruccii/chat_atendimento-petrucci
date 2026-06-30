import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function MediaError() {
  return (
    <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
      <AlertTriangle className="h-4 w-4 text-destructive" strokeWidth={1.5} />
      <span className="text-xs text-destructive flex-1">Mídia indisponível</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={() => toast.info("Em breve")}
      >
        <RefreshCw className="h-3 w-3 mr-1" strokeWidth={1.5} />
        Tentar novamente
      </Button>
    </div>
  );
}
