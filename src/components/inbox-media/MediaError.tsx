import { useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { InboxMessage } from "@/lib/inbox-queries";
import { type EscopoMidia, reprocessarMidia } from "@/lib/midia-acoes";

interface Props {
  /** Opcional (retrocompatível): com o tipo, o erro reserva a mesma altura que
   *  a mídia carregada teria. Sem isso, falhar depois do esqueleto (que já
   *  reservava aquele espaço, ver MediaLoading) faz o chat pular de posição. */
  tipo?: InboxMessage["tipo"];
  /** Sem o id não há o que reprocessar (ex.: falha ao assinar a URL do bucket,
   *  que não se resolve pedindo o arquivo de novo ao WhatsApp) — aí o botão
   *  some em vez de virar um clique que não faz nada. */
  mensagemId?: string;
  escopo?: EscopoMidia;
  /** Quando o arquivo passa do teto do Storage: o tamanho em bytes (0 = sem
   *  número). Aí a bolha explica o motivo e não oferece nova tentativa, que
   *  traria exatamente o mesmo arquivo. */
  grandeDemaisBytes?: number;
}

function emMegabytes(bytes: number): string | null {
  if (!bytes || !Number.isFinite(bytes)) return null;
  return `${(bytes / 1048576).toFixed(0)} MB`;
}

function textoGrande(bytes: number): string {
  const tamanho = emMegabytes(bytes);
  return tamanho
    ? `Arquivo grande demais (${tamanho}) — peça por e-mail`
    : "Arquivo grande demais — peça por e-mail";
}

function reservedBoxClass(tipo?: InboxMessage["tipo"]): string {
  if (tipo === "imagem") return "aspect-[4/3] w-full max-w-full";
  if (tipo === "video") return "aspect-video w-full max-w-full";
  if (tipo === "sticker") return "h-32 w-32";
  return "";
}

export function MediaError({ tipo, mensagemId, escopo, grandeDemaisBytes }: Props) {
  const [tentando, setTentando] = useState(false);

  const grandeDemais = grandeDemaisBytes !== undefined;
  const podeReprocessar = Boolean(mensagemId && escopo) && !grandeDemais;

  const tentarNovamente = async () => {
    if (!mensagemId || !escopo || tentando) return;
    setTentando(true);
    try {
      const r = await reprocessarMidia({ mensagemId, escopo });
      if (r.ok) toast.success("Baixando o arquivo de novo. Isso pode levar alguns segundos.");
      else toast.info(r.motivo ?? "Não foi possível tentar de novo agora.");
    } catch {
      toast.error("Não foi possível tentar de novo. Verifique a conexão.");
    } finally {
      setTentando(false);
    }
  };

  const pill = (
    <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
      <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" strokeWidth={1.5} />
      <span className="flex-1 text-xs text-destructive">
        {grandeDemais ? textoGrande(grandeDemaisBytes) : "Mídia indisponível"}
      </span>
      {podeReprocessar && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 shrink-0 text-xs"
          disabled={tentando}
          onClick={tentarNovamente}
        >
          {tentando ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" strokeWidth={1.5} />
          ) : (
            <RefreshCw className="h-3 w-3 mr-1" strokeWidth={1.5} />
          )}
          Tentar novamente
        </Button>
      )}
    </div>
  );

  const reserved = reservedBoxClass(tipo);
  if (!reserved) return pill;

  // Imagem/vídeo/sticker: a pilula de erro fica centralizada dentro de uma
  // caixa do tamanho que a mídia carregada teria — mesma lógica do skeleton.
  return (
    <div className={`flex items-center justify-center rounded-md bg-muted ${reserved}`}>{pill}</div>
  );
}
