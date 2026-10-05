import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Eye, KanbanSquare, Rows3, Search, SearchX, X } from "lucide-react";
import { SupervisaoKanban } from "@/components/supervisao/SupervisaoKanban";
import { SupervisaoRowCard } from "@/components/supervisao/SupervisaoRowCard";
import {
  SupervisaoFilterSheet,
  type PeriodPreset,
  type StatusFilter,
  type AgentFilter,
} from "@/components/supervisao/SupervisaoFilterSheet";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { supabase } from "@/integrations/supabase/client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  fetchDepartments,
  fetchCollaborators,
} from "@/lib/pendentes-queries";
import {
  fetchSupervisao,
  STATUS_LABEL,
  STATUS_OPTIONS,
  STATUS_BADGE,
  formatDateShort,
  formatTimeShort,
} from "@/lib/supervisao-queries";

export const Route = createFileRoute("/_app/supervisao")({
  staticData: { title: "Supervisão" },
  component: SupervisaoGuard,
});

// Tipos e a lista de status do filtro moraram para SupervisaoFilterSheet:
// a folha do celular e esta rota precisam dos dois exatamente iguais.

function deptStyle(cor: string): React.CSSProperties {
  return { backgroundColor: `${cor}20`, color: cor };
}

function SupervisaoGuard() {
  useCurrentUser();
  return <SupervisaoPage />;
}

function SupervisaoPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();

  const [period, setPeriod] = useState<PeriodPreset>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [department, setDepartment] = useState<string>("all");
  const [agent, setAgent] = useState<AgentFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [view, setView] = useState<"tabela" | "kanban">("tabela");
  useEffect(() => {
    const v = localStorage.getItem("supervisao_view");
    if (v === "kanban" || v === "tabela") setView(v);
  }, []);
  const pageSize = 15;

  const setViewPersist = (v: "tabela" | "kanban") => {
    setView(v);
    try { localStorage.setItem("supervisao_view", v); } catch { /* noop */ }
  };

  const supervisaoQuery = useQuery({
    queryKey: ["supervisao"],
    queryFn: fetchSupervisao,
    enabled: !!user,
    refetchInterval: 60_000,
  });

  const deptsQuery = useQuery({ queryKey: ["departments-active"], queryFn: fetchDepartments });
  const agentsQuery = useQuery({ queryKey: ["collaborators-active"], queryFn: fetchCollaborators });

  // Realtime
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("supervisao-watch")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "atendimentos" },
        () => queryClient.invalidateQueries({ queryKey: ["supervisao"] }),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "mensagens" },
        () => queryClient.invalidateQueries({ queryKey: ["supervisao"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, queryClient]);

  const rows = supervisaoQuery.data ?? [];
  const departments = deptsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];

  const filtered = useMemo(() => {
    const now = Date.now();
    return rows.filter((r) => {
      if (department !== "all" && r.departmentId !== department) return false;
      if (agent === "none" && r.assignedTo) return false;
      if (agent !== "all" && agent !== "none" && r.assignedTo !== agent) return false;
      if (status !== "all" && r.status !== status) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !r.clientNome.toLowerCase().includes(q) &&
          !r.clientNumero.toLowerCase().includes(q)
        )
          return false;
      }
      const created = new Date(r.createdAt).getTime();
      const ageDays = (now - created) / 86_400_000;
      if (period === "hoje" && ageDays > 1) return false;
      if (period === "7d" && ageDays > 7) return false;
      if (period === "30d" && ageDays > 30) return false;
      if (period === "custom") {
        if (customFrom && created < new Date(customFrom).getTime()) return false;
        if (customTo && created > new Date(customTo).getTime() + 86_400_000) return false;
      }
      return true;
    });
  }, [rows, department, agent, status, query, period, customFrom, customTo]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const aT = new Date(a.lastMessageAt ?? a.createdAt).getTime();
      const bT = new Date(b.lastMessageAt ?? b.createdAt).getTime();
      return bT - aT;
    });
  }, [filtered]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const clearFilters = () => {
    setPeriod("30d");
    setDepartment("all");
    setAgent("all");
    setStatus("all");
    setQuery("");
    setCustomFrom("");
    setCustomTo("");
    setPage(1);
  };

  const openInSupervision = (id: string) => {
    navigate({ to: "/inbox", search: { mode: "supervision", conversation: id } });
  };

  const isLoading = supervisaoQuery.isLoading;

  return (
    <>
      {/* Cabeçalho: no celular o alternador desce para uma linha própria e a
          descrição some — com o título, o alternador e os filtros embaixo,
          não sobra altura para uma linha só decorativa. */}
      <div className="mb-4 flex flex-col gap-3 md:mb-5 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-semibold text-foreground">Supervisão</h1>
            <span className="text-sm text-muted-foreground">
              {sorted.length} {sorted.length === 1 ? "conversa" : "conversas"}
            </span>
          </div>
          <p className="mt-1 hidden text-sm text-muted-foreground md:block">
            Visão completa de todos os atendimentos, em todos os departamentos.
          </p>
        </div>
        <div className="inline-flex self-start rounded-md border border-border bg-card p-0.5">
          <button
            onClick={() => setViewPersist("tabela")}
            className={`flex items-center gap-1.5 rounded px-2.5 py-2 text-xs md:py-1 ${
              view === "tabela" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Rows3 className="h-3.5 w-3.5" /> Tabela
          </button>
          <button
            onClick={() => setViewPersist("kanban")}
            className={`flex items-center gap-1.5 rounded px-2.5 py-2 text-xs md:py-1 ${
              view === "kanban" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <KanbanSquare className="h-3.5 w-3.5" /> Kanban
          </button>
        </div>
      </div>
      {/* Filtros — celular: busca + botão "Filtros" que abre a folha inferior
          com os 4 selects. Os mesmos estados (period, department, agent...)
          alimentam as duas marcações; só a barra desktop fica escondida. */}
      <SupervisaoFilterSheet
        period={period}
        onPeriodChange={setPeriod}
        customFrom={customFrom}
        onCustomFromChange={setCustomFrom}
        customTo={customTo}
        onCustomToChange={setCustomTo}
        department={department}
        onDepartmentChange={setDepartment}
        departments={departments}
        agent={agent}
        onAgentChange={setAgent}
        agents={agents}
        status={status}
        onStatusChange={setStatus}
        query={query}
        onQueryChange={setQuery}
        resultCount={sorted.length}
        onClear={clearFilters}
      />
      {/* Filtros — desktop: barra horizontal original, inalterada. */}
      <div className="mb-4 hidden flex-wrap items-center gap-2 md:flex">
        <div className="flex items-center gap-2">
          <Select value={period} onValueChange={(v) => setPeriod(v as PeriodPreset)}>
            <SelectTrigger className="h-9 w-[170px]">
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
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-9">
                  {customFrom && customTo
                    ? `${customFrom} → ${customTo}`
                    : "Selecionar datas"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-3" align="start">
                <div className="flex flex-col gap-2">
                  <label className="text-xs text-muted-foreground">De</label>
                  <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
                  <label className="text-xs text-muted-foreground">Até</label>
                  <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>

        <Select value={department} onValueChange={(v) => setDepartment(v)}>
          <SelectTrigger className="h-9 w-[180px]">
            <SelectValue placeholder="Departamento" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos departamentos</SelectItem>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>{d.nome}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={agent} onValueChange={(v) => setAgent(v as AgentFilter)}>
          <SelectTrigger className="h-9 w-[180px]">
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

        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="h-9 w-[160px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos status</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar cliente ou telefone"
            className="h-9 w-[240px] pl-8"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <button
          onClick={clearFilters}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Limpar filtros
        </button>
      </div>
      {view === "kanban" ? (
        isLoading ? (
          <div className="p-6 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-12 rounded-md bg-muted animate-pulse" />
            ))}
          </div>
        ) : (
          <SupervisaoKanban rows={sorted} currentUserId={user?.id ?? null} />
        )
      ) : (
      <>
      {/* Tabela → cartão no celular: 7 colunas não cabem em 360px sem obrigar
          a arrastar a tela. Cartão e tabela leem a mesma `pageRows` (já
          filtrada/ordenada/paginada) — só a marcação muda. A borda/sombra que
          "emoldura" a tabela no desktop some no celular porque cada cartão
          já tem a própria borda; empilhados dentro de outra borda ficaria
          "caixa dentro de caixa". */}
      <div className="overflow-hidden md:rounded-2xl md:border md:border-border md:bg-card md:shadow-sm">
        {isLoading ? (
          <div className="p-6 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-12 rounded-md bg-muted animate-pulse" />
            ))}
          </div>
        ) : pageRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <SearchX className="h-10 w-10 text-muted-foreground" strokeWidth={1.2} />
            <p className="mt-3 text-sm font-medium text-foreground">
              Nenhuma conversa encontrada
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Tente ajustar os filtros.
            </p>
          </div>
        ) : (
          <>
          <div className="space-y-2 md:hidden">
            {pageRows.map((r) => (
              <SupervisaoRowCard key={r.id} row={r} onOpen={() => openInSupervision(r.id)} />
            ))}
          </div>
          <table className="hidden w-full text-sm md:table">
            <thead className="bg-muted">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Cliente</th>
                <th className="px-4 py-3 font-medium">Departamento</th>
                <th className="px-4 py-3 font-medium">Atendente</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Última mensagem</th>
                <th className="px-4 py-3 font-medium">Início</th>
                <th className="px-4 py-3 font-medium text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r, i) => (
                <tr
                  key={r.id}
                  onClick={() => openInSupervision(r.id)}
                  className={`cursor-pointer border-t border-border transition-colors hover:bg-muted ${
                    i % 2 === 1 ? "bg-[#FAFBFC]" : ""
                  }`}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-xs font-medium text-primary">
                        {r.initials}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm text-foreground truncate">{r.clientNome}</div>
                        <div className="text-xs text-muted-foreground">{r.clientNumero}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {r.departmentNome ? (
                      <span className="text-[11px] px-2 py-0.5 rounded" style={deptStyle(r.departmentCor)}>
                        {r.departmentNome}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {r.assignedTo ? (
                      <div className="flex items-center gap-2">
                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-foreground">
                          {r.assignedNome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("")}
                        </div>
                        <span className="text-xs text-foreground">{r.assignedNome}</span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground italic">Sem dono</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-[11px] px-2 py-0.5 rounded ${STATUS_BADGE[r.status]}`}>
                      {STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <div className="max-w-[260px] truncate">
                      {r.lastMessagePreview || <span className="italic opacity-60">—</span>}
                    </div>
                    <div className="text-[11px] text-muted-foreground/80">
                      {formatTimeShort(r.lastMessageAt)}
                      {r.closedAt && (
                        <span className="ml-1">· encerrado {formatDateShort(r.closedAt)}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatDateShort(r.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openInSupervision(r.id);
                        }}
                        className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Abrir conversa"
                      >
                        <Eye className="h-4 w-4" strokeWidth={1.5} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </>
        )}
      </div>
      {/* Paginação */}
      {pageRows.length > 0 && (
        <div className="mt-3 flex items-center justify-end gap-3 text-xs text-muted-foreground">
          <span>
            {(currentPage - 1) * pageSize + 1}-
            {Math.min(currentPage * pageSize, sorted.length)} de {sorted.length}
          </span>
          {/* touch-target-mobile: 24px de alvo (p-1 + ícone 16px) erra o dedo;
              44px só entra abaixo de 768px, o desktop fica do jeito que era. */}
          <div className="flex items-center gap-2 md:gap-1">
            <button
              disabled={currentPage === 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="touch-target-mobile flex items-center justify-center rounded p-1 hover:bg-muted disabled:opacity-40"
              aria-label="Página anterior"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              disabled={currentPage === totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="touch-target-mobile flex items-center justify-center rounded p-1 hover:bg-muted disabled:opacity-40"
              aria-label="Próxima página"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
      </>
      )}
    </>
  )
}
