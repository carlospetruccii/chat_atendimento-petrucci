import { FileText, Loader2 } from "lucide-react";
import { initialsOf } from "@/lib/inbox-queries";
import { classeStatus, type DocsConversa, rotuloStatus } from "@/lib/docs-logic";

interface Props {
  conversas: DocsConversa[];
  selectedId: string | null;
  meuUserId: string;
  isLoading: boolean;
  temFiltro: boolean;
  onSelect: (id: string) => void;
  formatTime: (iso: string | null) => string;
}

/** Lista de conversas do número financeiro — mesma cara da lista da Inbox. */
export function DocsList({
  conversas,
  selectedId,
  meuUserId,
  isLoading,
  temFiltro,
  onSelect,
  formatTime,
}: Props) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando conversas...
      </div>
    );
  }

  if (conversas.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <FileText className="mx-auto h-10 w-10 text-muted-foreground" strokeWidth={1.2} />
        <p className="mt-3 text-sm text-muted-foreground">
          {temFiltro
            ? "Nenhuma conversa nesse filtro."
            : "Nenhuma conversa no número financeiro ainda. Elas aparecem sozinhas quando o sistema envia um documento ou o cliente escreve."}
        </p>
      </div>
    );
  }

  return (
    <ul>
      {conversas.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => onSelect(c.id)}
            // min-h-16 (64px): alvo confortável para o dedo, igual à lista de grupos.
            className={`relative min-h-16 w-full border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted ${
              selectedId === c.id
                ? "bg-[color-mix(in_oklab,var(--wa-green)_12%,transparent)] before:absolute before:left-0 before:top-0 before:h-full before:w-1 before:bg-primary"
                : ""
            }`}
          >
            <div className="flex gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-medium text-primary">
                {initialsOf(c.clientNome) || "?"}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {c.clientNome}
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {c.unread > 0 && (
                      <span className="badge-counter flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none">
                        {c.unread}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatTime(c.lastMessageAt ?? c.createdAt)}
                    </span>
                  </div>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {c.lastMessagePreview || "—"}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${classeStatus(c.status)}`}>
                    {rotuloStatus(c.status)}
                  </span>
                  {c.status === "em_andamento" && (
                    <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                      {c.assignedTo === meuUserId ? "com você" : `com ${c.assignedNome ?? "—"}`}
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
