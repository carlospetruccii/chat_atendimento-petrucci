import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2, Users } from "lucide-react";
import { formatarNumero } from "@/lib/phone";
import { fetchGrupoParticipantes } from "@/lib/grupos-queries";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface Props {
  grupoId: string;
  grupoNome: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Painel lateral com a lista de participantes do grupo, buscada em tempo real na uazapi. */
export function GrupoParticipantesSheet({ grupoId, grupoNome, open, onOpenChange }: Props) {
  const query = useQuery({
    queryKey: ["grupos", "participantes", grupoId],
    queryFn: () => fetchGrupoParticipantes(grupoId),
    enabled: open,
  });

  const participantes = query.data ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex flex-col p-0">
        <SheetHeader className="border-b border-border px-6 py-4 text-left">
          <SheetTitle className="truncate">{grupoNome}</SheetTitle>
          <SheetDescription>
            {query.isLoading
              ? "Carregando participantes…"
              : `${participantes.length} participante${participantes.length === 1 ? "" : "s"}`}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto scroll-contain">
          {query.isLoading && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Carregando participantes…
            </div>
          )}

          {query.isError && (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-muted-foreground">
              <AlertCircle className="h-5 w-5 text-destructive" />
              {query.error instanceof Error
                ? query.error.message
                : "Não foi possível carregar os participantes agora."}
            </div>
          )}

          {!query.isLoading && !query.isError && participantes.length === 0 && (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
              Nenhum participante encontrado.
            </div>
          )}

          {!query.isLoading && !query.isError && participantes.length > 0 && (
            <ul>
              {participantes.map((p) => (
                <li
                  key={p.numero}
                  className="flex items-center gap-3 border-b border-border px-6 py-3 last:border-b-0"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-primary">
                    <Users className="h-4 w-4" strokeWidth={1.8} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {p.nome ?? formatarNumero(`+${p.numero}`)}
                      </span>
                      {p.souNos && (
                        <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] text-primary">
                          nosso número
                        </span>
                      )}
                    </div>
                    {p.nome && (
                      <div className="truncate text-xs text-muted-foreground">
                        {formatarNumero(`+${p.numero}`)}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
