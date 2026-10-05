import { useState } from "react";
import { ListFilter, Search, X } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { STATUS_LABEL, STATUS_OPTIONS } from "@/lib/supervisao-queries";
import type { DeptOption, CollaboratorOption } from "@/lib/pendentes-queries";
import type { AtendimentoStatus } from "@/lib/inbox-queries";

export type PeriodPreset = "hoje" | "7d" | "30d" | "custom";
export type StatusFilter = "all" | AtendimentoStatus;
export type AgentFilter = "all" | "none" | string;

// Única lista de status do filtro — a rota importa daqui para não ter duas
// cópias (barra desktop e folha do celular) que podem descolar uma da outra.
const DEFAULT_PERIOD: PeriodPreset = "30d";

interface Props {
  period: PeriodPreset;
  onPeriodChange: (v: PeriodPreset) => void;
  customFrom: string;
  onCustomFromChange: (v: string) => void;
  customTo: string;
  onCustomToChange: (v: string) => void;
  department: string;
  onDepartmentChange: (v: string) => void;
  departments: DeptOption[];
  agent: AgentFilter;
  onAgentChange: (v: AgentFilter) => void;
  agents: CollaboratorOption[];
  status: StatusFilter;
  onStatusChange: (v: StatusFilter) => void;
  query: string;
  onQueryChange: (v: string) => void;
  resultCount: number;
  onClear: () => void;
}

/**
 * Filtros da Supervisão no celular: busca sempre visível + botão "Filtros"
 * (com contador) que abre uma folha inferior com os 4 selects em largura
 * cheia. A barra horizontal original (5 controles de largura fixa) empilhava
 * em 6 linhas e comia a tela antes de qualquer conversa aparecer.
 * No desktop a rota mantém a barra de sempre (`hidden md:flex`); este
 * componente só renderiza no `md:hidden`.
 */
export function SupervisaoFilterSheet({
  period,
  onPeriodChange,
  customFrom,
  onCustomFromChange,
  customTo,
  onCustomToChange,
  department,
  onDepartmentChange,
  departments,
  agent,
  onAgentChange,
  agents,
  status,
  onStatusChange,
  query,
  onQueryChange,
  resultCount,
  onClear,
}: Props) {
  const [open, setOpen] = useState(false);

  const activeCount = [
    period !== DEFAULT_PERIOD,
    department !== "all",
    agent !== "all",
    status !== "all",
  ].filter(Boolean).length;

  return (
    <div className="mb-4 flex items-center gap-2 md:hidden">
      <div className="relative min-w-0 flex-1">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          strokeWidth={1.5}
        />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Buscar cliente ou telefone"
          className="w-full pl-8 pr-8"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            className="touch-target-mobile absolute right-0 top-1/2 flex -translate-y-1/2 items-center justify-center text-muted-foreground hover:text-foreground"
            aria-label="Limpar busca"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="outline" className="shrink-0 gap-1.5">
            <ListFilter className="h-4 w-4" strokeWidth={1.5} />
            Filtros
            {activeCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground">
                {activeCount}
              </span>
            )}
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>Filtros</SheetTitle>
            <SheetDescription>Período, departamento, atendente e status.</SheetDescription>
          </SheetHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Período</label>
              <Select value={period} onValueChange={(v) => onPeriodChange(v as PeriodPreset)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Período" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hoje">Hoje</SelectItem>
                  <SelectItem value="7d">Últimos 7 dias</SelectItem>
                  <SelectItem value="30d">Últimos 30 dias</SelectItem>
                  <SelectItem value="custom">Customizado</SelectItem>
                </SelectContent>
              </Select>
              {period === "custom" && (
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">De</label>
                    <Input
                      type="date"
                      value={customFrom}
                      onChange={(e) => onCustomFromChange(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Até</label>
                    <Input
                      type="date"
                      value={customTo}
                      onChange={(e) => onCustomToChange(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Departamento</label>
              <Select value={department} onValueChange={onDepartmentChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Departamento" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos departamentos</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.nome}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Atendente</label>
              <Select value={agent} onValueChange={(v) => onAgentChange(v as AgentFilter)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Atendente" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos atendentes</SelectItem>
                  <SelectItem value="none">Sem dono</SelectItem>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.nome}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Status</label>
              <Select value={status} onValueChange={(v) => onStatusChange(v as StatusFilter)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos status</SelectItem>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={onClear}>
              Limpar filtros
            </Button>
            <Button className="flex-1" onClick={() => setOpen(false)}>
              Ver {resultCount} {resultCount === 1 ? "resultado" : "resultados"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
