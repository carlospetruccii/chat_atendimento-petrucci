import { supabase } from "@/integrations/supabase/client";
import type { DashboardRange } from "./dashboard-queries";
import type { FaixaHistograma, Iniciativa, Transferencias } from "./relacionamento-format";

/**
 * Acesso às métricas de relacionamento (RPC dashboard_relacionamento).
 *
 * O RPC devolve `jsonb`, que o supabase-js tipa como `Json` — ou seja, sem
 * garantia de forma em tempo de compilação. Em vez de validar e explodir, o
 * payload passa por `normalizarRelacionamento`, que preenche o que faltar com
 * zero/lista vazia. Assim uma mudança de schema no servidor degrada para "sem
 * dados no período" em vez de derrubar a dashboard inteira.
 */

export interface PiorPrimeiraResposta {
  atendimento_id: string;
  cliente: string | null;
  min: number;
  quando: string;
}

export interface PrimeiraResposta {
  total: number;
  sem_resposta: number;
  media_min: number | string | null;
  p50_min: number | string | null;
  p95_min: number | string | null;
  max_min: number | null;
  pior: PiorPrimeiraResposta | null;
  histograma: FaixaHistograma[];
}

export interface Peregrinacao {
  atendimento_id: string;
  cliente: string | null;
  saltos: number;
  /** Departamentos na ordem em que o cliente passou: ["Fiscal","Contábil",…]. */
  caminho: string[];
  quando: string;
}

export interface ContaReativa {
  client_id: string;
  cliente: string | null;
  conversas: number;
  pct_cliente: number | string;
}

export interface QuedaEngajamento {
  client_id: string;
  cliente: string | null;
  agora: number;
  antes: number;
  delta_pct: number | string;
  dias_sem_contato: number;
}

export interface Engajamento {
  janela_dias: number;
  /** true quando o RPC encurtou a régua por falta de histórico anterior. */
  janela_reduzida: boolean;
  baseline_min: number;
  limite_queda_pct: number | string;
  clientes_avaliados: number;
  em_queda: number;
  msgs_agora: number;
  msgs_antes: number;
  quedas: QuedaEngajamento[];
}

export interface TransferenciasCompletas extends Transferencias {
  distribuicao: FaixaHistograma[];
  peregrinacoes: Peregrinacao[];
}

export interface IniciativaCompleta extends Iniciativa {
  contas_reativas: ContaReativa[];
}

export interface RelacionamentoData {
  primeira_resposta: PrimeiraResposta;
  transferencias: TransferenciasCompletas;
  iniciativa: IniciativaCompleta;
  engajamento: Engajamento;
}

function num(valor: unknown, padrao = 0): number {
  if (typeof valor === "number" && Number.isFinite(valor)) return valor;
  if (typeof valor === "string") {
    const n = Number(valor);
    if (Number.isFinite(n)) return n;
  }
  return padrao;
}

function lista<T>(valor: unknown): T[] {
  return Array.isArray(valor) ? (valor as T[]) : [];
}

function objeto(valor: unknown): Record<string, unknown> {
  return valor && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

/**
 * Preenche o payload do RPC com defaults seguros. Exportada para teste: é aqui
 * que mora a resiliência da seção, então precisa de cobertura própria.
 */
export function normalizarRelacionamento(bruto: unknown): RelacionamentoData {
  const raiz = objeto(bruto);
  const pr = objeto(raiz.primeira_resposta);
  const tr = objeto(raiz.transferencias);
  const ini = objeto(raiz.iniciativa);
  const eng = objeto(raiz.engajamento);

  const pior = objeto(pr.pior);
  const temPior = typeof pior.atendimento_id === "string";

  return {
    primeira_resposta: {
      total: num(pr.total),
      sem_resposta: num(pr.sem_resposta),
      // Percentis ficam como null quando não há amostra — formatarMinutos
      // transforma isso em travessão, que é o certo. Não virar 0.
      media_min: pr.media_min == null ? null : num(pr.media_min),
      p50_min: pr.p50_min == null ? null : num(pr.p50_min),
      p95_min: pr.p95_min == null ? null : num(pr.p95_min),
      max_min: pr.max_min == null ? null : num(pr.max_min),
      pior: temPior
        ? {
            atendimento_id: pior.atendimento_id as string,
            cliente: typeof pior.cliente === "string" ? pior.cliente : null,
            min: num(pior.min),
            quando: typeof pior.quando === "string" ? pior.quando : "",
          }
        : null,
      histograma: lista<FaixaHistograma>(pr.histograma).map((f) => ({
        faixa: String(f?.faixa ?? ""),
        total: num(f?.total),
      })),
    },
    transferencias: {
      conversas: num(tr.conversas),
      com_transferencia: num(tr.com_transferencia),
      duas_ou_mais: num(tr.duas_ou_mais),
      total_saltos: num(tr.total_saltos),
      distribuicao: lista<FaixaHistograma>(tr.distribuicao).map((f) => ({
        faixa: String(f?.faixa ?? ""),
        total: num(f?.total),
      })),
      peregrinacoes: lista<Peregrinacao>(tr.peregrinacoes).map((p) => ({
        atendimento_id: String(p?.atendimento_id ?? ""),
        cliente: typeof p?.cliente === "string" ? p.cliente : null,
        saltos: num(p?.saltos),
        caminho: lista<string>(p?.caminho).map((d) => String(d)),
        quando: String(p?.quando ?? ""),
      })),
    },
    iniciativa: {
      total: num(ini.total),
      cliente: num(ini.cliente),
      empresa: num(ini.empresa),
      empresa_pelo_sistema: num(ini.empresa_pelo_sistema),
      empresa_fora_do_sistema: num(ini.empresa_fora_do_sistema),
      sem_mensagem: num(ini.sem_mensagem),
      contas_reativas: lista<ContaReativa>(ini.contas_reativas).map((c) => ({
        client_id: String(c?.client_id ?? ""),
        cliente: typeof c?.cliente === "string" ? c.cliente : null,
        conversas: num(c?.conversas),
        pct_cliente: num(c?.pct_cliente),
      })),
    },
    engajamento: {
      janela_dias: num(eng.janela_dias, 30),
      janela_reduzida: eng.janela_reduzida === true,
      baseline_min: num(eng.baseline_min, 5),
      limite_queda_pct: num(eng.limite_queda_pct, -50),
      clientes_avaliados: num(eng.clientes_avaliados),
      em_queda: num(eng.em_queda),
      msgs_agora: num(eng.msgs_agora),
      msgs_antes: num(eng.msgs_antes),
      quedas: lista<QuedaEngajamento>(eng.quedas).map((q) => ({
        client_id: String(q?.client_id ?? ""),
        cliente: typeof q?.cliente === "string" ? q.cliente : null,
        agora: num(q?.agora),
        antes: num(q?.antes),
        delta_pct: num(q?.delta_pct),
        dias_sem_contato: num(q?.dias_sem_contato),
      })),
    },
  };
}

export async function fetchRelacionamento(range: DashboardRange): Promise<RelacionamentoData> {
  const { data, error } = await supabase.rpc("dashboard_relacionamento", {
    p_from: range.from,
    p_to: range.to,
  });

  if (error) throw error;
  return normalizarRelacionamento(data);
}
