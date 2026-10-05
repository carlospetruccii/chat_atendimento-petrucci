import { useEffect, useState } from "react";
import { Download, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type EscopoMidia, reprocessarMidia } from "@/lib/midia-acoes";
import { tituloSobDemanda } from "@/lib/midia-sob-demanda";

/**
 * Se o arquivo não chegar pelo realtime nesse tempo (download falhou em
 * silêncio, realtime caiu), o botão volta a funcionar. Maior que a trava de 30s
 * da docs-acao, para o novo clique não bater em "tentativa_recente".
 */
const REABILITAR_MS = 60_000;

interface Props {
  tipo: string;
  fileName: string | null;
  mensagemId?: string;
  escopo?: EscopoMidia;
}

/**
 * Documento do sistema financeiro que ainda não foi baixado (ver
 * midia-sob-demanda.ts). Visual neutro — não é erro, é "toque para baixar".
 * Depois do clique fica em "Baixando…": o arquivo chega pelo realtime da
 * mensagem, e aí a bolha troca este componente pela mídia de verdade (ou pelo
 * erro, se o download falhar).
 */
export function MediaSobDemanda({ tipo, fileName, mensagemId, escopo }: Props) {
  const [baixando, setBaixando] = useState(false);
  const podeBaixar = Boolean(mensagemId && escopo);

  useEffect(() => {
    if (!baixando) return;
    const t = setTimeout(() => setBaixando(false), REABILITAR_MS);
    return () => clearTimeout(t);
  }, [baixando]);

  const baixar = async () => {
    if (!mensagemId || !escopo || baixando) return;
    setBaixando(true);
    try {
      const r = await reprocessarMidia({ mensagemId, escopo });
      if (r.ok) {
        toast.success("Baixando o arquivo…");
        return;
      }
      toast.info(r.motivo ?? "Não foi possível baixar agora.");
      setBaixando(false);
    } catch {
      toast.error("Não foi possível baixar. Verifique a conexão.");
      setBaixando(false);
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/60 px-3 py-2">
      <FileText className="h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">
          {fileName ?? tituloSobDemanda(tipo)}
        </p>
        {fileName && (
          <p className="truncate text-[11px] text-muted-foreground">{tituloSobDemanda(tipo)}</p>
        )}
      </div>
      {podeBaixar && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 shrink-0 text-xs"
          disabled={baixando}
          onClick={baixar}
        >
          {baixando ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" strokeWidth={1.5} />
          ) : (
            <Download className="mr-1 h-3 w-3" strokeWidth={1.5} />
          )}
          {baixando ? "Baixando…" : "Baixar"}
        </Button>
      )}
    </div>
  );
}
