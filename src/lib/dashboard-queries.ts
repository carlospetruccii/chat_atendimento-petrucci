import { supabase } from "@/integrations/supabase/client";
import {
  SEM_FILTRO,
  paresDeFiltro,
  type CondicaoFiltro,
  type DashboardFiltros,
} from "./dashboard-filtros";

export const FALLBACK_DEPT_COR = "#64748b";

export interface DashboardData {
  mainKpis: {
    emAberto: number;
    encerrados: number;
    mensagens: number;
  };
  volumeKpis: {
    atendimentosNoPeriodo: number;
    encerradosNoPeriodo: number;
    taxaEncerrados: string;
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

/**
 * Aplica as condições do filtro numa query do supabase-js. O cast existe porque
 * o builder tipa `.eq`/`.is` pelo nome literal da coluna, e aqui a coluna vem
 * de dashboard-filtros (string). As colunas são fixas lá, não vêm do usuário.
 */
function comFiltro<Q>(query: Q, condicoes: ReadonlyArray<CondicaoFiltro>): Q {
  return condicoes.reduce((q, { coluna, op, valor }) => {
    const builder = q as unknown as {
      eq: (c: string, v: string) => Q;
      is: (c: string, v: null) => Q;
    };
    return op === "is" ? builder.is(coluna, null) : builder.eq(coluna, valor as string);
  }, query);
}

/** Teto de linhas que o PostgREST devolve por requisição. */
const LINHAS_POR_PAGINA = 1000;

interface QueryPaginavel<T> {
  range: (de: number, ate: number) => PromiseLike<{ data: T[] | null; error: unknown }>;
}

/**
 * Lê TODAS as linhas de uma query, em páginas.
 *
 * Sem isso o PostgREST corta em 1000 linhas e a dashboard mostraria menos sem
 * avisar assim que um período passasse desse tamanho. `criarQuery` precisa
 * devolver uma query nova a cada chamada (builder do supabase-js é de uso
 * único) e com ordenação estável, senão a paginação repete ou pula linha.
 */
export async function todasAsLinhas<T>(criarQuery: () => QueryPaginavel<T>): Promise<T[]> {
  const linhas: T[] = [];
  for (let pagina = 0; ; pagina += 1) {
    const de = pagina * LINHAS_POR_PAGINA;
    const { data, error } = await criarQuery().range(de, de + LINHAS_POR_PAGINA - 1);
    if (error) throw error;
    const lote = data ?? [];
    linhas.push(...lote);
    if (lote.length < LINHAS_POR_PAGINA) return linhas;
  }
}

export interface OpcaoFiltro {
  id: string;
  nome: string;
}

export async function fetchOpcoesFiltro(): Promise<{
  departamentos: OpcaoFiltro[];
  pessoas: OpcaoFiltro[];
}> {
  const [deptsRes, usersRes] = await Promise.all([
    supabase.from("departments").select("id, nome").eq("ativo", true).order("ordem").order("nome"),
    // Inativo entra na lista: ele continua dono das conversas que atendeu, e
    // sem ele esse histórico não apareceria em filtro nenhum.
    supabase.from("users").select("id, nome, ativo").eq("is_system_user", false).order("nome"),
  ]);
  if (deptsRes.error) throw deptsRes.error;
  if (usersRes.error) throw usersRes.error;
  return {
    departamentos: deptsRes.data ?? [],
    pessoas: (usersRes.data ?? []).map((u) => ({
      id: u.id,
      nome: u.ativo ? u.nome : `${u.nome} (inativo)`,
    })),
  };
}

/**
 * Dos atendimentos que ENTRARAM no período, quantos % já estão encerrados.
 * Numerador e denominador são a mesma população, então fica entre 0 e 100%.
 */
export function taxaEncerrados(encerrados: number, total: number): string {
  if (total <= 0) return "—";
  return `${Math.round((Math.min(encerrados, total) / total) * 100)}%`;
}

export async function fetchDashboard(
  range: DashboardRange,
  filtros: DashboardFiltros = SEM_FILTRO,
): Promise<DashboardData> {
  const { from, to } = range;
  const fAtendimento = paresDeFiltro(filtros, "atendimento");
  const fEmAberto = paresDeFiltro(filtros, "emAberto");
  const fMensagem = paresDeFiltro(filtros, "mensagem");

  // Últimos 7 dias para o gráfico de barras (independente do filtro)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const [
    emAbertoRes,
    encerradosRes,
    mensagensRes,
    atendimentosPeriodoRes,
    encerradosDosAbertosRes,
    deptRows,
    last7Rows,
  ] = await Promise.all([
    comFiltro(
      supabase
        .from("atendimentos")
        .select("id", { count: "exact", head: true })
        // 'pendente' é conversa esperando alguém do setor pegar — está em
        // aberto tanto quanto as outras.
        .in("status", ["em_triagem", "pendente", "reservado", "em_atendimento"]),
      fEmAberto,
    ),
    comFiltro(
      supabase
        .from("atendimentos")
        .select("id", { count: "exact", head: true })
        .eq("status", "encerrado")
        .gte("closed_at", from)
        .lte("closed_at", to),
      fAtendimento,
    ),
    comFiltro(
      supabase
        .from("mensagens")
        .select("id", { count: "exact", head: true })
        .gte("created_at", from)
        .lte("created_at", to),
      fMensagem,
    ),
    comFiltro(
      supabase
        .from("atendimentos")
        .select("id", { count: "exact", head: true })
        .gte("created_at", from)
        .lte("created_at", to),
      fAtendimento,
    ),
    comFiltro(
      supabase
        .from("atendimentos")
        .select("id", { count: "exact", head: true })
        .eq("status", "encerrado")
        .gte("created_at", from)
        .lte("created_at", to),
      fAtendimento,
    ),
    todasAsLinhas<{ current_department_id: string | null }>(() =>
      comFiltro(
        supabase
          .from("atendimentos")
          .select("current_department_id")
          .gte("created_at", from)
          .lte("created_at", to)
          .order("id"),
        fAtendimento,
      ),
    ),
    todasAsLinhas<{ created_at: string }>(() =>
      comFiltro(
        supabase
          .from("atendimentos")
          .select("created_at")
          .gte("created_at", sevenDaysAgo.toISOString())
          .order("id"),
        fAtendimento,
      ),
    ),
  ]);

  const errors = [
    emAbertoRes,
    encerradosRes,
    mensagensRes,
    atendimentosPeriodoRes,
    encerradosDosAbertosRes,
  ]
    .map((r) => r.error)
    .filter(Boolean);
  if (errors.length) throw errors[0];

  // Por dia da semana (últimos 7 dias)
  const dowCount: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const row of last7Rows) {
    const d = new Date(row.created_at).getDay();
    dowCount[d] = (dowCount[d] ?? 0) + 1;
  }
  const porDiaSemana = DOW_ORDER.map((dow) => ({
    day: DOW_LABELS[dow],
    value: dowCount[dow] ?? 0,
  }));

  // Por departamento
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
    deptInfo = new Map(
      (ds ?? []).map((d) => [d.id, { nome: d.nome, cor: d.cor || FALLBACK_DEPT_COR }]),
    );
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
  const taxa = taxaEncerrados(encerradosDosAbertosRes.count ?? 0, atendimentosNoPeriodo);

  return {
    mainKpis: {
      emAberto: emAbertoRes.count ?? 0,
      encerrados: encerradosNoPeriodo,
      mensagens: mensagensRes.count ?? 0,
    },
    volumeKpis: {
      atendimentosNoPeriodo,
      encerradosNoPeriodo,
      taxaEncerrados: taxa,
    },
    porDiaSemana,
    porDepartamento,
  };
}

export function resolveRange(period: string, custom?: { from?: Date; to?: Date }): DashboardRange {
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
