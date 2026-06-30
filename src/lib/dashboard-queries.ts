import { supabase } from "@/integrations/supabase/client";

export const FALLBACK_DEPT_COR = "#64748b";

export interface DashboardData {
  mainKpis: {
    emAberto: number;
    encerrados: number;
    tmpPrimeiraResposta: string;
    mensagens: number;
  };
  volumeKpis: {
    atendimentosNoPeriodo: number;
    encerradosNoPeriodo: number;
    taxaResolucao: string;
  };
  porDiaSemana: { day: string; value: number }[];
  porDepartamento: { name: string; value: number; color: string }[];
}

export interface DashboardRange {
  from: string; // ISO
  to: string; // ISO
}

const DOW_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Seg..Dom

function formatDuracaoMin(totalMs: number): string {
  if (!isFinite(totalMs) || totalMs <= 0) return "—";
  const totalSec = Math.round(totalMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const h = Math.floor(min / 60);
  const restMin = min % 60;
  return `${h}h ${restMin}min`;
}

export async function fetchDashboard(range: DashboardRange): Promise<DashboardData> {
  const { from, to } = range;

  // Últimos 7 dias para o gráfico de barras (independente do filtro)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const [
    emAbertoRes,
    encerradosRes,
    primeiraRespostaRes,
    mensagensRes,
    atendimentosPeriodoRes,
    porDeptRes,
    last7Res,
  ] = await Promise.all([
    supabase
      .from("atendimentos")
      .select("id", { count: "exact", head: true })
      .in("status", ["em_triagem", "reservado", "em_atendimento"]),
    supabase
      .from("atendimentos")
      .select("id", { count: "exact", head: true })
      .eq("status", "encerrado")
      .gte("closed_at", from)
      .lte("closed_at", to),
    supabase
      .from("atendimentos")
      .select("created_at, first_response_at")
      .not("first_response_at", "is", null)
      .gte("created_at", from)
      .lte("created_at", to),
    supabase
      .from("mensagens")
      .select("id", { count: "exact", head: true })
      .gte("created_at", from)
      .lte("created_at", to),
    supabase
      .from("atendimentos")
      .select("id", { count: "exact", head: true })
      .gte("created_at", from)
      .lte("created_at", to),
    supabase
      .from("atendimentos")
      .select("current_department_id")
      .gte("created_at", from)
      .lte("created_at", to),
    supabase
      .from("atendimentos")
      .select("created_at")
      .gte("created_at", sevenDaysAgo.toISOString()),
  ]);

  const errors = [emAbertoRes, encerradosRes, primeiraRespostaRes, mensagensRes, atendimentosPeriodoRes, porDeptRes, last7Res]
    .map((r) => r.error)
    .filter(Boolean);
  if (errors.length) throw errors[0];

  // Tempo médio 1ª resposta
  const respRows = (primeiraRespostaRes.data ?? []) as { created_at: string; first_response_at: string }[];
  let tmpStr = "—";
  if (respRows.length) {
    const total = respRows.reduce(
      (acc, r) => acc + (new Date(r.first_response_at).getTime() - new Date(r.created_at).getTime()),
      0,
    );
    tmpStr = formatDuracaoMin(total / respRows.length);
  }

  // Por dia da semana (últimos 7 dias)
  const dowCount: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const row of (last7Res.data ?? []) as { created_at: string }[]) {
    const d = new Date(row.created_at).getDay();
    dowCount[d] = (dowCount[d] ?? 0) + 1;
  }
  const porDiaSemana = DOW_ORDER.map((dow) => ({ day: DOW_LABELS[dow], value: dowCount[dow] ?? 0 }));

  // Por departamento
  const deptRows = (porDeptRes.data ?? []) as { current_department_id: string | null }[];
  const deptCount = new Map<string | null, number>();
  for (const r of deptRows) {
    const k = r.current_department_id;
    deptCount.set(k, (deptCount.get(k) ?? 0) + 1);
  }
  const deptIds = Array.from(deptCount.keys()).filter((id): id is string => !!id);
  let deptInfo = new Map<string, { nome: string; cor: string }>();
  if (deptIds.length) {
    const { data: ds, error } = await supabase
      .from("departments")
      .select("id, nome, cor")
      .in("id", deptIds);
    if (error) throw error;
    deptInfo = new Map((ds ?? []).map((d) => [d.id, { nome: d.nome, cor: d.cor || FALLBACK_DEPT_COR }]));
  }
  const porDepartamento: { name: string; value: number; color: string }[] = [];
  for (const [id, value] of deptCount.entries()) {
    if (!id) {
      porDepartamento.push({ name: "Sem departamento", value, color: FALLBACK_DEPT_COR });
    } else {
      const info = deptInfo.get(id);
      porDepartamento.push({
        name: info?.nome ?? "—",
        value,
        color: info?.cor ?? FALLBACK_DEPT_COR,
      });
    }
  }
  porDepartamento.sort((a, b) => b.value - a.value);

  const atendimentosNoPeriodo = atendimentosPeriodoRes.count ?? 0;
  const encerradosNoPeriodo = encerradosRes.count ?? 0;
  const taxa = atendimentosNoPeriodo > 0
    ? `${Math.round((encerradosNoPeriodo / atendimentosNoPeriodo) * 100)}%`
    : "—";

  return {
    mainKpis: {
      emAberto: emAbertoRes.count ?? 0,
      encerrados: encerradosNoPeriodo,
      tmpPrimeiraResposta: tmpStr,
      mensagens: mensagensRes.count ?? 0,
    },
    volumeKpis: {
      atendimentosNoPeriodo,
      encerradosNoPeriodo,
      taxaResolucao: taxa,
    },
    porDiaSemana,
    porDepartamento,
  };
}

export function resolveRange(
  period: string,
  custom?: { from?: Date; to?: Date },
): DashboardRange {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  switch (period) {
    case "hoje":
      return { from: startOfToday.toISOString(), to: endOfToday.toISOString() };
    case "ontem": {
      const startY = new Date(startOfToday);
      startY.setDate(startY.getDate() - 1);
      const endY = new Date(startY);
      endY.setHours(23, 59, 59, 999);
      return { from: startY.toISOString(), to: endY.toISOString() };
    }
    case "30d": {
      const f = new Date(now);
      f.setDate(f.getDate() - 30);
      return { from: f.toISOString(), to: now.toISOString() };
    }
    case "custom": {
      if (custom?.from && custom?.to) {
        const f = new Date(custom.from);
        f.setHours(0, 0, 0, 0);
        const t = new Date(custom.to);
        t.setHours(23, 59, 59, 999);
        return { from: f.toISOString(), to: t.toISOString() };
      }
      // fallback 7d
      const f = new Date(now);
      f.setDate(f.getDate() - 7);
      return { from: f.toISOString(), to: now.toISOString() };
    }
    case "7d":
    default: {
      const f = new Date(now);
      f.setDate(f.getDate() - 7);
      return { from: f.toISOString(), to: now.toISOString() };
    }
  }
}
