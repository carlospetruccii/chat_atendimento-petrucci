import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { listColegasInternos, type ColegaInterno } from "@/lib/internas-queries";
import { iniciaisDoNome } from "@/lib/internas-history";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Abre a conversa com essa pessoa (cria se ainda não existir). */
  onEscolher: (colega: ColegaInterno) => void;
  abrindo: boolean;
}

function deptStyle(cor: string | null): React.CSSProperties | undefined {
  if (!cor) return undefined;
  return { backgroundColor: `${cor}1A`, color: cor };
}

/**
 * "Com quem você quer falar?" — lista os colegas da empresa. Conversar não
 * depende de a conversa já existir: escolher alguém aqui cria a thread na hora
 * (RPC idempotente), então não há estado intermediário de "convite".
 */
export function NovaConversaDialog({ open, onOpenChange, onEscolher, abrindo }: Props) {
  const [filtro, setFiltro] = useState("");

  const colegasQuery = useQuery({
    queryKey: ["internas", "colegas"],
    queryFn: listColegasInternos,
    enabled: open,
    staleTime: 60_000,
  });

  const colegas = colegasQuery.data ?? [];
  const termo = filtro.trim().toLowerCase();
  const filtrados = termo
    ? colegas.filter(
        (c) =>
          c.nome.toLowerCase().includes(termo) ||
          (c.departmentNome?.toLowerCase().includes(termo) ?? false),
      )
    : colegas;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Conversar com alguém do time</DialogTitle>
          <DialogDescription>
            A conversa acontece dentro do sistema — não passa pelo WhatsApp.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.8}
          />
          <input
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            type="text"
            autoFocus
            placeholder="Buscar por nome ou setor..."
            className="w-full rounded-2xl border border-border bg-card py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div className="max-h-[320px] overflow-y-auto">
          {colegasQuery.isLoading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando time...
            </div>
          ) : filtrados.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {termo
                ? "Ninguém encontrado com esse termo."
                : "Você é a única pessoa ativa na empresa por aqui."}
            </p>
          ) : (
            <ul className="space-y-1">
              {filtrados.map((c) => (
                <li key={c.userId}>
                  <button
                    type="button"
                    disabled={abrindo}
                    onClick={() => onEscolher(c)}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    <span className="relative shrink-0">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-xs font-semibold text-primary">
                        {iniciaisDoNome(c.nome)}
                      </span>
                      {/* Ponto de disponibilidade: mesmo sinal usado na fila de
                          atendimento, para não inventar um vocabulário novo. */}
                      <span
                        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card ${
                          c.disponivel ? "bg-primary" : "bg-muted-foreground/40"
                        }`}
                        aria-hidden
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {c.nome}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5">
                        {c.departmentNome && (
                          <span
                            className="rounded px-1.5 py-0.5 text-[10px]"
                            style={deptStyle(c.departmentCor)}
                          >
                            {c.departmentNome}
                          </span>
                        )}
                        <span className="text-[11px] text-muted-foreground">
                          {c.disponivel ? "disponível" : "indisponível"}
                        </span>
                      </span>
                    </span>
                    {c.conversaId && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        já conversaram
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
