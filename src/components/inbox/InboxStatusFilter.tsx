import { ListFilter, CircleDot, CircleCheck, MailWarning } from "lucide-react";

export type InboxStatusFilterValue = "todos" | "em_andamento" | "encerrado" | "nao_visto";

interface Props {
  value: InboxStatusFilterValue;
  counts: Record<InboxStatusFilterValue, number>;
  onChange: (value: InboxStatusFilterValue) => void;
}

const OPCOES: { id: InboxStatusFilterValue; label: string; Icon: typeof ListFilter }[] = [
  { id: "todos", label: "Todos", Icon: ListFilter },
  { id: "em_andamento", label: "Em andamento", Icon: CircleDot },
  { id: "encerrado", label: "Encerrado", Icon: CircleCheck },
  { id: "nao_visto", label: "Não visualizadas", Icon: MailWarning },
];

/**
 * Filtro por status da conversa, em pills. Seleção única (radio): escolher uma
 * opção substitui a anterior — "Todos" não é "nenhum filtro", é o quarto estado.
 *
 * No celular os rótulos ("Em andamento", "Não visualizadas") não cabem lado a
 * lado: em vez de quebrar em três linhas e empurrar a lista para baixo, a
 * faixa rola na horizontal (`shrink-0` em cada pill impede que elas espremam
 * o texto — o scroll assume o excesso).
 */
export function InboxStatusFilter({ value, counts, onChange }: Props) {
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
