import { createFileRoute } from "@tanstack/react-router";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  Clock,
  Activity,
  MessageCircle,
  MessageSquare,
  CalendarIcon,
} from "lucide-react";
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
import { fetchDashboard, resolveRange } from "@/lib/dashboard-queries";

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
  highlight?: boolean;
}

function DashboardPage() {
  const [period, setPeriod] = useState("hoje");
  const [customFrom, setCustomFrom] = useState<Date | undefined>();
  const [customTo, setCustomTo] = useState<Date | undefined>();

  const range = useMemo(
    () => resolveRange(period, { from: customFrom, to: customTo }),
    [period, customFrom, customTo],
  );

  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ["dashboard", range.from, range.to],
    queryFn: () => fetchDashboard(range),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  const emAberto = data?.mainKpis.emAberto ?? 0;

  const mainKpis: MainKpi[] = [
    {
      label: "Em aberto agora",
      value: data ? String(emAberto) : "—",
      icon: Clock,
      highlight: emAberto > 5,
    },
    {
      label: "Encerrados no período",
      value: data ? String(data.mainKpis.encerrados) : "—",
      icon: Activity,
    },
    {
      label: "Tempo médio 1ª resposta",
      value: data ? data.mainKpis.tmpPrimeiraResposta : "—",
      icon: MessageCircle,
    },
    {
      label: "Mensagens no período",
      value: data ? String(data.mainKpis.mensagens) : "—",
      icon: MessageSquare,
    },
  ];

  const volumeKpis = [
    { label: "Atendimentos no período", value: data ? String(data.volumeKpis.atendimentosNoPeriodo) : "—" },
    { label: "Encerrados no período", value: data ? String(data.volumeKpis.encerradosNoPeriodo) : "—" },
    { label: "Taxa de resolução", value: data ? data.volumeKpis.taxaResolucao : "—" },
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
        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Visão geral do atendimento — atualizado a cada 60s.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-[180px]">
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
              <>
                <DateField label="De" value={customFrom} onChange={setCustomFrom} />
                <DateField label="Até" value={customTo} onChange={setCustomTo} />
              </>
            )}
          </div>
        </div>

        {/* Main KPIs */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {mainKpis.map((k) => {
            const Icon = k.icon;
            return (
              <div
                key={k.label}
                className="rounded-2xl bg-card p-6 shadow-sm border border-border"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[color-mix(in_oklab,var(--wa-green)_15%,transparent)]">
                  <Icon className="h-5 w-5 text-primary" strokeWidth={1.75} />
                </div>
                <div className="mt-4 text-xs font-medium text-muted-foreground">
                  {k.label}
                </div>
                <div className="mt-2 flex items-baseline gap-3">
                  <span
                    className={`text-[32px] font-semibold leading-none ${
                      k.highlight ? "text-destructive" : "text-foreground"
                    }`}
                  >
                    {k.value}
                  </span>
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
              className="rounded-2xl bg-card px-6 py-4 shadow-sm border border-border"
            >
              <div className="text-xs font-medium text-muted-foreground">
                {k.label}
              </div>
              <div className="mt-1 text-2xl font-semibold text-foreground">
                {k.value}
              </div>
            </div>
          ))}
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-2xl bg-card p-6 shadow-sm border border-border">
            <div className="text-sm font-medium text-foreground">
              Atendimentos por dia (últimos 7 dias)
            </div>
            <div className="mt-4 h-64">
              {hasBar ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                    <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: "#6B7280", fontSize: 12 }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fill: "#6B7280", fontSize: 12 }} allowDecimals={false} />
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

          <div className="rounded-2xl bg-card p-6 shadow-sm border border-border">
            <div className="text-sm font-medium text-foreground">
              Distribuição por departamento
            </div>
            <div className="mt-4 flex h-64 items-center gap-6">
              {hasPie ? (
                <>
                  <div className="h-full flex-1">
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
                            <Cell key={entry.name} fill={entry.color} stroke="white" strokeWidth={2} />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(value: number) => `${value}`}
                          contentStyle={{ borderRadius: 8, border: "1px solid #E5E7EB", fontSize: 12 }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="flex flex-col gap-2 pr-2 max-h-full overflow-auto">
                    {pieData.map((entry) => {
                      const pct = totalPie > 0 ? Math.round((entry.value / totalPie) * 100) : 0;
                      return (
                        <li key={entry.name} className="flex items-center gap-2 text-sm">
                          <span
                            className="h-2.5 w-2.5 rounded-sm"
                            style={{ backgroundColor: entry.color }}
                          />
                          <span className="text-foreground">{entry.name}</span>
                          <span className="text-muted-foreground">{pct}%</span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : (
                <div className="flex-1 h-full"><EmptyChart /></div>
              )}
            </div>
          </div>
        </div>

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
            "w-[160px] justify-start text-left font-normal",
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
