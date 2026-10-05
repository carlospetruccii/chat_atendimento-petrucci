import { CircleCheck, CircleDot, Inbox, ListFilter } from "lucide-react";
import type { DocsFiltro } from "@/lib/docs-logic";

interface Props {
  value: DocsFiltro;
  counts: Record<DocsFiltro, number>;
  onChange: (value: DocsFiltro) => void;
}

const OPCOES: { id: DocsFiltro; label: string; Icon: typeof ListFilter }[] = [
  { id: "todas", label: "Todas", Icon: ListFilter },
  { id: "sem_dono", label: "Sem dono", Icon: Inbox },
  { id: "em_andamento", label: "Em andamento", Icon: CircleDot },
  { id: "encerradas", label: "Encerradas", Icon: CircleCheck },
];

/**
 * Filtro por status da conversa do Docs, em pills — mesmo visual do filtro da
 * Inbox (InboxStatusFilter). "Todas" inclui as que só receberam documento.
 * No celular a faixa rola na horizontal em vez de quebrar linha.
 */
export function DocsStatusFilter({ value, counts, onChange }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="Filtrar conversas por status"
      className="flex gap-1.5 overflow-x-auto no-scrollbar"
    >
      {OPCOES.map(({ id, label, Icon }) => {
        const ativo = value === id;
        const count = counts[id];
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={ativo}
            onClick={() => onChange(id)}
            className={`flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              ativo
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
            }`}
          >
            <Icon className="h-3 w-3" strokeWidth={2} />
            {label}
            {count > 0 && (
              <span
                className={`ml-0.5 rounded-full px-1.5 text-[10px] font-bold leading-[15px] ${
                  ativo ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
