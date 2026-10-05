import { Loader2, MessagesSquare } from "lucide-react";
import type { ConversaInterna } from "@/lib/internas-queries";
import { iniciaisDoNome } from "@/lib/internas-history";

interface Props {
  conversas: ConversaInterna[];
  selectedId: string | null;
  isLoading: boolean;
  temFiltro: boolean;
  onSelect: (id: string) => void;
  onNovaConversa: () => void;
  formatTime: (iso: string | null) => string;
}

function deptStyle(cor: string | null): React.CSSProperties | undefined {
  if (!cor) return undefined;
  return { backgroundColor: `${cor}1A`, color: cor };
}

export function ConversasInternasList({
  conversas,
  selectedId,
  isLoading,
  temFiltro,
  onSelect,
  onNovaConversa,
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
        <MessagesSquare className="mx-auto h-10 w-10 text-muted-foreground" strokeWidth={1.2} />
        <p className="mt-3 text-sm text-muted-foreground">
          {temFiltro
            ? "Nenhuma conversa encontrada com esse termo."
            : "Nenhuma conversa por aqui ainda."}
        </p>
        {!temFiltro && (
          <button
            onClick={onNovaConversa}
            className="mt-3 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Chamar alguém do time
          </button>
        )}
      </div>
    );
  }

  return (
    <ul>
      {conversas.map((c) => (
        <li key={c.id}>
          <button
            onClick={() => onSelect(c.id)}
            // min-h-16 (64px): alvo confortável para o dedo, mesmo critério da
            // lista de grupos.
            className={`relative min-h-16 w-full border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted ${
              selectedId === c.id
                ? "bg-[color-mix(in_oklab,var(--wa-green)_12%,transparent)] before:absolute before:left-0 before:top-0 before:h-full before:w-1 before:bg-primary"
                : ""
            }`}
          >
            <div className="flex gap-3">
              <span className="relative shrink-0">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-sm font-medium text-primary">
                  {iniciaisDoNome(c.outroNome)}
                </span>
                <span
                  className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card ${
                    c.outroDisponivel ? "bg-primary" : "bg-muted-foreground/40"
                  }`}
                  aria-label={c.outroDisponivel ? "disponível" : "indisponível"}
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {c.outroNome}
                  </span>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-xs text-muted-foreground">
                      {formatTime(c.lastMessageAt)}
                    </span>
                    {c.unread > 0 && (
                      <span className="badge-counter flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none">
                        {c.unread}
                      </span>
                    )}
                  </div>
                </div>
                <p
                  className={`mt-0.5 truncate text-xs ${
                    c.unread > 0 ? "font-medium text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {c.lastMessagePreview || "Conversa nova — diga oi"}
                </p>
                {c.outroDepartmentNome && (
                  <div className="mt-2">
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px]"
                      style={deptStyle(c.outroDepartmentCor)}
                    >
                      {c.outroDepartmentNome}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
