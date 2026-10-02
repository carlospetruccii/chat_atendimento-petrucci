import { Loader2, RefreshCw, Users } from "lucide-react";
import type { Grupo } from "@/lib/grupos-queries";
import { FotoPerfil } from "@/components/FotoPerfil";

interface Props {
  grupos: Grupo[];
  selectedId: string | null;
  isLoading: boolean;
  isSyncing: boolean;
  temFiltro: boolean;
  onSelect: (id: string) => void;
  onSync: () => void;
  formatTime: (iso: string | null) => string;
}

/** Iniciais do nome do grupo para o avatar (fallback quando não há foto). */
function iniciais(nome: string): string {
  return nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
}

export function GruposList({
  grupos,
  selectedId,
  isLoading,
  isSyncing,
  temFiltro,
  onSelect,
  onSync,
  formatTime,
}: Props) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando grupos...
      </div>
    );
  }

  if (grupos.length === 0) {
    // Enquanto a sincronização automática roda, a lista vazia é estado
    // transitório — dizer "nenhum grupo" aqui seria mentira momentânea.
    if (isSyncing && !temFiltro) {
      return (
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Buscando grupos no WhatsApp...
        </div>
      );
    }

    return (
      <div className="px-6 py-12 text-center">
        <Users className="mx-auto h-10 w-10 text-muted-foreground" strokeWidth={1.2} />
        <p className="mt-3 text-sm text-muted-foreground">
          {temFiltro
            ? "Nenhum grupo encontrado com esse termo."
            : "Nenhum grupo por aqui. Grupos aparecem sozinhos quando alguém manda mensagem neles."}
        </p>
        {!temFiltro && (
          // Escape hatch: se a busca automática falhou, sem isso a tela fica
          // sem saída. Discreto de propósito — não é ação de rotina.
          <button
            onClick={onSync}
            className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            <RefreshCw className="h-3 w-3" strokeWidth={1.8} />
            Buscar no WhatsApp de novo
          </button>
        )}
      </div>
    );
  }

  return (
    <ul>
      {grupos.map((g) => (
        <li key={g.id}>
          <button
            onClick={() => onSelect(g.id)}
            className={`relative w-full text-left px-4 py-3 border-b border-border hover:bg-muted transition-colors ${
              selectedId === g.id
                ? "bg-[color-mix(in_oklab,var(--wa-green)_12%,transparent)] before:absolute before:left-0 before:top-0 before:h-full before:w-1 before:bg-primary"
                : ""
            }`}
          >
            <div className="flex gap-3">
              <FotoPerfil url={g.fotoUrl} fallback={iniciais(g.nome)} />
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-foreground truncate">{g.nome}</span>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-xs text-muted-foreground">
                      {formatTime(g.lastMessageAt)}
                    </span>
                    {g.unread > 0 && (
                      <span className="badge-counter flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none">
                        {g.unread}
                      </span>
                    )}
                  </div>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground truncate">
                  {g.lastMessagePreview || "—"}
                </p>
                <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                  <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    <Users className="h-3 w-3" strokeWidth={1.8} />
                    {g.participantesTotal ?? "—"}
                  </span>
                  {g.somenteAdminEnvia && !g.souAdmin && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                      só admin envia
                    </span>
                  )}
                </div>
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
