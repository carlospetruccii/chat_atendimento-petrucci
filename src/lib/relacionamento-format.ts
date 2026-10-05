/**
 * Formatadores e derivações puras das métricas de relacionamento.
 *
 * Fica separado de relacionamento-queries.ts de propósito: tudo aqui é função
 * pura sobre o JSON que o RPC devolve, então dá pra testar sem tocar em rede
 * nem em Supabase.
 *
 * Cuidado com tipos: `round()` e `percentile_cont()` no Postgres devolvem
 * `numeric`, e numeric chega no JSON como STRING, não number. Todas as entradas
 * numéricas aqui aceitam `number | string` e normalizam.
 */

export type NumeroDoBanco = number | string | null | undefined;

export interface FaixaHistograma {
  faixa: string;
  total: number;
}

/**
 * Estas duas interfaces carregam SÓ os contadores escalares que as funções
 * puras deste módulo consomem. As listas (peregrinacoes, distribuicao) vivem
 * nos tipos "Completa" de relacionamento-queries, que
 * estendem estes. Misturar as listas aqui obrigaria a interseção de tipos no
 * componente, e interseção de arrays não estreita o elemento.
 */
export interface Iniciativa {
  total: number;
  cliente: number;
  empresa: number;
  empresa_pelo_sistema: number;
  empresa_fora_do_sistema: number;
  sem_mensagem: number;
}

export interface Transferencias {
  conversas: number;
  com_transferencia: number;
  duas_ou_mais: number;
  total_saltos: number;
}

const MINUTOS_POR_HORA = 60;

function paraNumero(valor: NumeroDoBanco): number | null {
  if (valor === null || valor === undefined) return null;
  const n = typeof valor === "string" ? Number(valor) : valor;
  return Number.isFinite(n) ? n : null;
}

/**
 * Formata uma duração em minutos ÚTEIS.
 *
 * `0` não é "sem dado": minutos_uteis_decorridos devolve o piso em minutos,
 * então uma resposta em 40 segundos chega como 0. Por isso zero vira "< 1min" e
 * só null/negativo viram travessão.
 */
export function formatarMinutos(min: NumeroDoBanco): string {
  const n = paraNumero(min);
  if (n === null || n < 0) return "—";
  if (n === 0) return "< 1min";
  if (n < MINUTOS_POR_HORA) return `${Math.round(n)}min`;

  const horas = Math.floor(n / MINUTOS_POR_HORA);
  const resto = Math.round(n % MINUTOS_POR_HORA);
  return resto === 0 ? `${horas}h` : `${horas}h ${resto}min`;
}

/** Percentual inteiro protegido contra divisão por zero. */
export function pct(parte: NumeroDoBanco, total: NumeroDoBanco): number {
  const p = paraNumero(parte) ?? 0;
  const t = paraNumero(total) ?? 0;
  if (t <= 0) return 0;
  return Math.round((p / t) * 100);
}

/**
 * Onde cada faixa do histograma deixa de ser boa. O RPC devolve 7 faixas em
 * ordem crescente (até 5min, 5–10, 10–15, 15–30, 30min–1h, 1h–1h30, +1h30);
 * agrupar por posição evita acoplar ao texto da faixa.
 */
const FAIXAS_RAPIDAS = 3; // até 15min
const FAIXAS_OK = 2; // 15min a 1h

export type TomEspera = "rapido" | "ok" | "lento";

export interface LinhaEspera {
  faixa: string;
  total: number;
  pct: number;
  tom: TomEspera;
}

export interface ResumoEspera {
  total: number;
  linhas: LinhaEspera[];
  /** % respondido em até 15 minutos de expediente. */
  pctAte15min: number;
}

function tomDaFaixa(indice: number): TomEspera {
  if (indice < FAIXAS_RAPIDAS) return "rapido";
  if (indice < FAIXAS_RAPIDAS + FAIXAS_OK) return "ok";
  return "lento";
}

/** Histograma de espera com percentual e tom de cada faixa. */
export function resumoEspera(histograma: FaixaHistograma[]): ResumoEspera {
  const total = histograma.reduce((acc, f) => acc + f.total, 0);
  const ate15 = histograma.slice(0, FAIXAS_RAPIDAS).reduce((acc, f) => acc + f.total, 0);

  return {
    total,
    linhas: histograma.map((f, i) => ({
      faixa: f.faixa,
      total: f.total,
      pct: pct(f.total, total),
      tom: tomDaFaixa(i),
    })),
    pctAte15min: pct(ate15, total),
  };
}

export interface ResumoIniciativa {
  pctReativo: number;
  pctProativo: number;
  /**
   * Quanto do contato proativo saiu por fora da plataforma (atendente
   * respondendo pelo celular). Alto aqui significa que o número "proativo" não
   * reflete uso do sistema.
   */
  pctProativoForaDoSistema: number;
}

export function resumoIniciativa(iniciativa: Iniciativa): ResumoIniciativa {
  return {
    pctReativo: pct(iniciativa.cliente, iniciativa.total),
    pctProativo: pct(iniciativa.empresa, iniciativa.total),
    pctProativoForaDoSistema: pct(iniciativa.empresa_fora_do_sistema, iniciativa.empresa),
  };
}

export interface ResumoTransferencias {
  /** Média de saltos entre departamentos por conversa, em pt-BR. */
  mediaPorConversa: string;
  pctComTransferencia: number;
  pctDuasOuMais: number;
}

export function resumoTransferencias(t: Transferencias): ResumoTransferencias {
  const media = t.conversas > 0 ? t.total_saltos / t.conversas : 0;
  return {
    mediaPorConversa: media.toFixed(2).replace(".", ","),
    pctComTransferencia: pct(t.com_transferencia, t.conversas),
    pctDuasOuMais: pct(t.duas_ou_mais, t.conversas),
  };
}
