import { AlertTriangle, Clock, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatWait, type PendenteRow } from "@/lib/pendentes-queries";

function deptBadgeStyle(cor: string): React.CSSProperties {
  return { backgroundColor: `${cor}20`, color: cor };
}

interface Props {
  item: PendenteRow;
  canAssign: boolean;
  isAttending: boolean;
  onAttend: () => void;
  onPreview: () => void;
  onAssign: () => void;
}

/**
 * Cartão da linha da tabela de Pendentes (visão "Tabela"), para o celular
 * (`md:hidden` na rota). Espelha as 5 colunas da tabela — sem a prévia de
 * mensagem, que só existe na visão "Grade" — para o alternador Grade/Tabela
 * continuar tendo sentido mesmo quando as duas viram cartão no celular.
 * Sem clique no cartão inteiro: "Atender" é mutação (atribui o atendimento),
 * não pode disparar sozinha com o toque em qualquer canto do cartão.
 */
export function PendenteRowCard({ item, canAssign, isAttending, onAttend, onPreview, onAssign }: Props) {
  return (
    <div className="rounded-2xl border border-border bg-card p-3.5 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-medium text-primary">
          {item.initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{item.clientNome}</div>
          <div className="truncate text-xs text-muted-foreground">{item.clientNumero}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" strokeWidth={1.5} />
          {formatWait(item.waitingMin)}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] px-2 py-0.5 rounded" style={deptBadgeStyle(item.departmentCor)}>
          {item.departmentNome ?? "—"}
        </span>
        {item.releasedByTimeout && (
          <span className="inline-flex items-center gap-1 text-[11px] text-[#92400E]">
            <AlertTriangle className="h-3 w-3" strokeWidth={1.8} />
            Liberado por timeout
          </span>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" onClick={onAttend} disabled={isAttending} className="flex-1">
          Atender
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onPreview}
          aria-label="Pré-visualizar mensagens"
          className="touch-target-mobile"
        >
          <Eye className="h-4 w-4" strokeWidth={1.5} />
        </Button>
        {canAssign && (
          <Button size="sm" variant="outline" onClick={onAssign}>
            Atribuir
          </Button>
        )}
      </div>
    </div>
  );
}
