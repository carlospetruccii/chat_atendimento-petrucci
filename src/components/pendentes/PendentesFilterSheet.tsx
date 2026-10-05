import { useState } from "react";
import { ListFilter, Lock, Search } from "lucide-react";
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
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DeptOption } from "@/lib/pendentes-queries";

export type WaitFilter = "all" | "lt30" | "30to120" | "gt120";
export type SortBy = "newest" | "longest" | "department";

const DEFAULT_WAIT: WaitFilter = "all";
const DEFAULT_SORT: SortBy = "longest";

interface Props {
  dept: string;
  onDeptChange: (v: string) => void;
  departments: DeptOption[];
  isSuperadmin: boolean;
  wait: WaitFilter;
  onWaitChange: (v: WaitFilter) => void;
  sortBy: SortBy;
  onSortByChange: (v: SortBy) => void;
  search: string;
  onSearchChange: (v: string) => void;
  resultCount: number;
}

/**
 * Filtros de Pendentes no celular: busca sempre visível + botão "Filtros"
 * (com contador) que abre uma folha inferior com os 3 selects em largura
 * cheia. Os 3 SelectTrigger de largura fixa da barra desktop (200/180/220px)
 * empilhavam ocupando a tela antes de qualquer cartão aparecer.
 * No desktop a rota mantém a barra de sempre (`hidden md:flex`); este
 * componente só renderiza no `md:hidden`.
 */
export function PendentesFilterSheet({
  dept,
  onDeptChange,
  departments,
  isSuperadmin,
  wait,
  onWaitChange,
  sortBy,
  onSortByChange,
  search,
  onSearchChange,
  resultCount,
}: Props) {
  const [open, setOpen] = useState(false);

  const activeCount = [wait !== DEFAULT_WAIT, sortBy !== DEFAULT_SORT].filter(Boolean).length;

  return (
    <div className="mb-6 flex items-center gap-2 md:hidden">
      <div className="relative min-w-0 flex-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
          strokeWidth={1.5}
        />
        {/* Input compartilhado, não <input> cru: é ele que carrega o alvo de
            toque maior no celular (h-10 sm:h-9). O irmão da Supervisão já usava
            este; manter os dois iguais evita que só um dos filtros fique
            confortável no dedo. */}
        <Input
          placeholder="Buscar..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
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
            <SheetDescription>Departamento, tempo de espera e ordenação.</SheetDescription>
          </SheetHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Departamento</label>
              <Select value={dept} onValueChange={onDeptChange} disabled={!isSuperadmin}>
                <SelectTrigger className="w-full bg-card">
                  <SelectValue />
                  {!isSuperadmin && (
                    <Lock className="ml-2 h-3 w-3 text-muted-foreground" strokeWidth={1.5} />
                  )}
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os departamentos</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.nome}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Tempo de espera</label>
              <Select value={wait} onValueChange={(v) => onWaitChange(v as WaitFilter)}>
                <SelectTrigger className="w-full bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Qualquer tempo</SelectItem>
                  <SelectItem value="lt30">Até 30min</SelectItem>
                  <SelectItem value="30to120">30min – 2h</SelectItem>
                  <SelectItem value="gt120">Mais de 2h</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Ordenar por</label>
              <Select value={sortBy} onValueChange={(v) => onSortByChange(v as SortBy)}>
                <SelectTrigger className="w-full bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Menor tempo aguardando</SelectItem>
                  <SelectItem value="longest">Maior tempo aguardando</SelectItem>
                  <SelectItem value="department">Por departamento</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Button className="w-full" onClick={() => setOpen(false)}>
            Ver {resultCount} {resultCount === 1 ? "resultado" : "resultados"}
          </Button>
        </SheetContent>
      </Sheet>
    </div>
  );
}
