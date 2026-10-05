import { createFileRoute } from "@tanstack/react-router";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { Clock, Activity, MessageCircle, MessageSquare, CalendarIcon } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fetchDashboard, fetchOpcoesFiltro, resolveRange } from "@/lib/dashboard-queries";
import {
  SEM_DEPARTAMENTO,
  TODOS,
  filtroDeSelect,
  type DashboardFiltros,
} from "@/lib/dashboard-filtros";
import { RelacionamentoSection } from "@/components/dashboard/RelacionamentoSection";
import { fetchRelacionamento } from "@/lib/relacionamento-queries";
import { formatarMinutos } from "@/lib/relacionamento-format";

export const Route = createFileRoute("/_app/dashboard")({
  staticData: { title: "Dashboard" },
  component: DashboardGuard,
});

function DashboardGuard() {
  useCurrentUser();
  return <DashboardPage />;
}

interface MainKpi {
  label: string;
  value: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement> & { strokeWidth?: number }>;
  /** Cor de identidade do card — aparece só como tinta leve no fundo e no ícone. */
  tom: string;
  highlight?: boolean;
}

function DashboardPage() {
  const [period, setPeriod] = useState("hoje");
  const [customFrom, setCustomFrom] = useState<Date | undefined>();
  const [customTo, setCustomTo] = useState<Date | undefined>();

  const [departamento, setDepartamento] = useState(TODOS);
  const [pessoa, setPessoa] = useState(TODOS);

  const range = useMemo(
    () => resolveRange(period, { from: customFrom, to: customTo }),
    [period, customFrom, customTo],
  );

  const filtros = useMemo<DashboardFiltros>(
    () => ({ departmentId: filtroDeSelect(departamento), userId: filtroDeSelect(pessoa) }),
    [departamento, pessoa],
  );

  const { data: opcoes } = useQuery({
    queryKey: ["dashboard-opcoes-filtro"],
    queryFn: fetchOpcoesFiltro,
    staleTime: 5 * 60_000,
  });

  // Mesma queryKey da seção de Relacionamento: o react-query serve as duas do
  // mesmo cache, então isso NÃO faz uma chamada a mais. O KPI do topo sai daqui
  // pra falar a mesma língua do card de baixo — minutos de expediente, só
  // conversa que o cliente puxou. Com contas diferentes, os dois números
  // pareciam se contradizer.
  const { data: relacionamento } = useQuery({
    queryKey: [
      "dashboard-relacionamento",
      range.from,
      range.to,
      filtros.departmentId,
      filtros.userId,
    ],
    queryFn: () => fetchRelacionamento(range, filtros),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ["dashboard", range.from, range.to, filtros.departmentId, filtros.userId],
    queryFn: () => fetchDashboard(range, filtros),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  const emAberto = data?.mainKpis.emAberto ?? 0;

  const mainKpis: MainKpi[] = [
    {
      label: "Em aberto agora",
      value: data ? String(emAberto) : "—",
      icon: Clock,
      tom: "oklch(0.72 0.14 70)",
      highlight: emAberto > 5,
    },
    {
      label: "Encerrados no período",
      value: data ? String(data.mainKpis.encerrados) : "—",
      icon: Activity,
      tom: "var(--wa-green)",
    },
    {
      label: "Tempo médio 1ª resposta",
      value: relacionamento ? formatarMinutos(relacionamento.primeira_resposta.media_min) : "—",
      icon: MessageCircle,
      tom: "oklch(0.65 0.12 245)",
    },
    {
      label: "Mensagens no período",
      value: data ? String(data.mainKpis.mensagens) : "—",
      icon: MessageSquare,
      tom: "oklch(0.62 0.13 295)",
    },
  ];

  const volumeKpis = [
    {
      label: "Atendimentos no período",
      value: data ? String(data.volumeKpis.atendimentosNoPeriodo) : "—",
    },
    {
      label: "Encerrados no período",
      value: data ? String(data.volumeKpis.encerradosNoPeriodo) : "—",
    },
    {
      label: "Taxa de atendimentos encerrados",
      value: data ? data.volumeKpis.taxaEncerrados : "—",
    },
  ];

  const barData = data?.porDiaSemana ?? [];
  const pieData = data?.porDepartamento ?? [];
  const totalPie = pieData.reduce((acc, p) => acc + p.value, 0);
  const hasBar = barData.some((b) => b.value > 0);
  const hasPie = pieData.length > 0;

  const lastUpdate = dataUpdatedAt ? format(new Date(dataUpdatedAt), "HH:mm") : "—";

  return (
    <>
      <div className="flex flex-col gap-8">
        {/* Header — empilha no celular (título em cima, filtros embaixo em
            largura cheia): três controles de largura fixa lado a lado com o
            título não cabem abaixo de 640px. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Visão geral do atendimento — atualizado a cada 60s.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hoje">Hoje</SelectItem>
                <SelectItem value="ontem">Ontem</SelectItem>
                <SelectItem value="7d">Últimos 7 dias</SelectItem>
                <SelectItem value="30d">Últimos 30 dias</SelectItem>
                <SelectItem value="custom">Customizado</SelectItem>
              </SelectContent>
            </Select>
            {period === "custom" && (
              <div className="grid grid-cols-2 gap-2 sm:flex">
                <DateField label="De" value={customFrom} onChange={setCustomFrom} />
                <DateField label="Até" value={customTo} onChange={setCustomTo} />
              </div>
            )}
            <Select value={departamento} onValueChange={setDepartamento}>
              <SelectTrigger className="w-full sm:w-[230px]" aria-label="Filtrar por departamento">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TODOS}>Todos os departamentos</SelectItem>
                {(opcoes?.departamentos ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.nome}
                  </SelectItem>
                ))}
                {/* Conversa encerrada ainda na triagem fica sem departamento —
                    sem esta opção ela não apareceria em filtro nenhum. */}
                <SelectItem value={SEM_DEPARTAMENTO}>Sem departamento</SelectItem>
              </SelectContent>
            </Select>
            <Select value={pessoa} onValueChange={setPessoa}>
              <SelectTrigger className="w-full sm:w-[200px]" aria-label="Filtrar por pessoa">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TODOS}>Todas as pessoas</SelectItem>
                {(opcoes?.pessoas ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Main KPIs — compactos, com a cor de cada um só como tinta leve
            (7% no fundo, 18% na borda e no ícone), misturada sobre --card. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {mainKpis.map((k) => {
            const Icon = k.icon;
            return (
              <div
                key={k.label}
                style={{ "--kpi": k.tom } as React.CSSProperties}
                className="flex items-center gap-3 rounded-xl border border-[color-mix(in_oklab,var(--kpi)_18%,var(--border))] bg-[color-mix(in_oklab,var(--kpi)_7%,var(--card))] px-4 py-3 shadow-sm"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_oklab,var(--kpi)_18%,transparent)]">
                  <Icon className="h-[18px] w-[18px] text-[var(--kpi)]" strokeWidth={1.75} />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-muted-foreground">
                    {k.label}
                  </div>
                  {/* tabular-nums: dígito de largura fixa, o número não "pula"
                      largura a cada refetch de 60s. */}
                  <div
                    className={`mt-0.5 text-xl font-semibold leading-tight tabular-nums ${
                      k.highlight ? "text-destructive" : "text-foreground"
                    }`}
                  >
                    {k.value}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Volume KPIs */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {volumeKpis.map((k) => (
            <div
              key={k.label}
              className="rounded-2xl bg-card px-4 py-4 sm:px-6 shadow-sm border border-border"
            >
              <div className="text-xs font-medium text-muted-foreground">{k.label}</div>
              <div className="mt-1 text-2xl font-semibold text-foreground tabular-nums">
                {k.value}
              </div>
            </div>
          ))}
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-2xl bg-card p-4 sm:p-6 shadow-sm border border-border">
            <div className="text-sm font-medium text-foreground">
              Atendimentos por dia (últimos 7 dias)
            </div>
            <div className="mt-4 h-64">
              {hasBar ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                    <XAxis
                      dataKey="day"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "#6B7280", fontSize: 12 }}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "#6B7280", fontSize: 12 }}
                      allowDecimals={false}
                    />
                    <Tooltip
                      cursor={{ fill: "#F8FAFC" }}
                      contentStyle={{ borderRadius: 8, border: "1px solid #E5E7EB", fontSize: 12 }}
                    />
                    <Bar dataKey="value" fill="var(--wa-green)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyChart />
              )}
            </div>
          </div>

          <div className="rounded-2xl bg-card p-4 sm:p-6 shadow-sm border border-border">
            <div className="text-sm font-medium text-foreground">Distribuição por departamento</div>
            {/* Pizza empilha sobre a legenda no celular: o outerRadius do Pie
                é em pixels fixos (recharts não escala por %), então lado a
                lado abaixo de sm a fatia ficava espremida a ponto de cortar.
                Em coluna, a pizza ganha a largura toda do card pra respirar. */}
            <div className="mt-4 flex flex-col items-center gap-4 sm:h-64 sm:flex-row sm:gap-6">
              {hasPie ? (
                <>
                  <div className="h-56 w-full min-w-0 sm:h-full sm:flex-1">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pieData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          innerRadius={50}
                          outerRadius={90}
                          paddingAngle={2}
                        >
                          {pieData.map((entry) => (
                            <Cell
                              key={entry.name}
                              fill={entry.color}
                              stroke="white"
                              strokeWidth={2}
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(value: number) => `${value}`}
                          contentStyle={{
                            borderRadius: 8,
                            border: "1px solid #E5E7EB",
                            fontSize: 12,
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="flex w-full min-w-0 flex-col gap-2 pr-2 sm:w-auto sm:max-h-full sm:overflow-auto">
                    {pieData.map((entry) => {
                      const pct = totalPie > 0 ? Math.round((entry.value / totalPie) * 100) : 0;
                      return (
                        <li key={entry.name} className="flex min-w-0 items-center gap-2 text-sm">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-sm"
                            style={{ backgroundColor: entry.color }}
                          />
                          {/* Nome de departamento não tem limite de tamanho —
                              min-w-0 é o que deixa o truncate cortar em vez de
                              empurrar a pizza pra fora do card. */}
                          <span className="min-w-0 truncate text-foreground">{entry.name}</span>
                          <span className="shrink-0 text-muted-foreground">{pct}%</span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : (
                <div className="h-56 w-full sm:h-full sm:flex-1">
                  <EmptyChart />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Relacionamento — métricas de experiência, só metadados */}
        <RelacionamentoSection range={range} filtros={filtros} />

        {/* Footer */}
        <div className="text-right text-xs text-muted-foreground">
          {isError
            ? "Erro ao carregar dados"
            : isLoading
              ? "Carregando..."
              : `Última atualização: ${lastUpdate} · Próxima em 60s`}
        </div>
      </div>
    </>
  );
}

function EmptyChart() {
  return (
    <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
      Sem dados no período
    </div>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Date | undefined;
  onChange: (d: Date | undefined) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "w-full justify-start text-left font-normal sm:w-[160px]",
            !value && "text-muted-foreground",
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {value ? format(value, "dd/MM/yyyy") : <span>{label}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          onSelect={onChange}
          initialFocus
          className={cn("p-3 pointer-events-auto")}
        />
      </PopoverContent>
    </Popover>
  );
}
