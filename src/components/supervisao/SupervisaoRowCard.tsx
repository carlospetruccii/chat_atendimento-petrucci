import { ChevronRight } from "lucide-react";
import {
  STATUS_BADGE,
  STATUS_LABEL,
  formatDateShort,
  formatTimeShort,
  type SupervisaoRow,
} from "@/lib/supervisao-queries";

function deptStyle(cor: string): React.CSSProperties {
  return { backgroundColor: `${cor}20`, color: cor };
}

interface Props {
  row: SupervisaoRow;
  onOpen: () => void;
}

/**
 * Cartão da linha da tabela de Supervisão, para o celular (`md:hidden` na
 * rota). A tabela tem 7 colunas — ilegível em 360px — então o cartão fica só
 * com o essencial: cliente (identificador), status, departamento/atendente
 * de apoio e a última mensagem. "Início" (data de abertura) some: quem
 * supervisiona olha a última mensagem, não quando o atendimento nasceu.
 * O cartão inteiro é o alvo de toque — mesma ação do clique na linha.
 */
export function SupervisaoRowCard({ row, onOpen }: Props) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-3 rounded-2xl border border-border bg-card p-3.5 text-left shadow-sm transition-colors hover:border-foreground/20 active:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-medium text-primary">
        {row.initials}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{row.clientNome}</div>
            <div className="truncate text-xs text-muted-foreground">{row.clientNumero}</div>
          </div>
          <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded ${STATUS_BADGE[row.status]}`}>
            {STATUS_LABEL[row.status]}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {row.departmentNome && (
            <span className="text-[11px] px-2 py-0.5 rounded" style={deptStyle(row.departmentCor)}>
              {row.departmentNome}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground">
            {row.assignedTo ? row.assignedNome : "Sem dono"}
          </span>
        </div>

        <div className="mt-1.5 text-xs text-muted-foreground">
          <div className="line-clamp-1">
            {row.lastMessagePreview || <span className="italic opacity-60">Sem mensagens</span>}
          </div>
          <div className="text-[11px] text-muted-foreground/80">
            {formatTimeShort(row.lastMessageAt)}
            {row.closedAt && <span className="ml-1">· encerrado {formatDateShort(row.closedAt)}</span>}
          </div>
        </div>
      </div>

      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground/60" strokeWidth={1.5} />
    </button>
  );
}
