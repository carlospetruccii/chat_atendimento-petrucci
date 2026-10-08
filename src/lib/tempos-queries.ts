import { supabase } from "@/integrations/supabase/client";

// ============ Tempos (system_config) ============

export type TempoUnit = "segundos" | "minutos" | "minutos úteis" | "horas" | ""; /* sem unidade */

/** Seções da aba Tempos. A ordem aqui é a ordem exibida na tela. */
export const TEMPO_GRUPOS = [
  {
    id: "triagem",
    titulo: "Bot de triagem",
    descricao: "Como o bot conversa com o cliente antes de entregar para uma pessoa.",
  },
  {
    id: "avisos",
    titulo: "Avisos internos no WhatsApp",
    descricao: "Quando a equipe é cobrada por cliente esperando sem atendimento.",
  },
  {
    id: "encerramento",
    titulo: "Encerramento",
    descricao: "Quando um atendimento é fechado sozinho por inatividade.",
  },
] as const;

export type TempoGrupoId = (typeof TEMPO_GRUPOS)[number]["id"];

export interface TempoMeta {
  chave: string;
  label: string;
  unit: TempoUnit;
  min: number;
  max: number;
  grupo: TempoGrupoId;
}

// Se o tempo faz efeito ou não NÃO fica aqui: quem diz é public.status_tempos()
// no banco, que olha os interruptores e os crons de verdade. Tempo novo aqui
// precisa de regra lá também, senão a tela mostra "Não foi possível confirmar".
export const TEMPOS: TempoMeta[] = [
  {
    chave: "delay_anti_flood_triagem",
    label: "Esperar o cliente terminar de digitar",
    unit: "segundos",
    min: 1,
    max: 300,
    grupo: "triagem",
  },
  {
    chave: "triagem_max_tentativas",
    label: "Tentativas antes do bot desistir e chamar uma pessoa",
    unit: "",
    min: 1,
    max: 10,
    grupo: "triagem",
  },
  {
    chave: "tempo_abandono_triagem",
    label: "Encerrar triagem quando o cliente para de responder",
    unit: "minutos",
    min: 1,
    max: 1440,
    grupo: "triagem",
  },
  {
    chave: "janela_continuidade_apos_encerramento",
    label: "Continuar no mesmo setor quando o cliente responde depois de encerrado",
    unit: "horas",
    min: 0,
    max: 720,
    grupo: "triagem",
  },
  {
    chave: "tempo_alerta_atendimento_parado",
    label: "Avisar o responsável do setor: cliente esperando sem atendimento",
    unit: "minutos úteis",
    min: 1,
    max: 1440,
    grupo: "avisos",
  },
  {
    chave: "intervalo_repeticao_alerta_atendimento_parado",
    label: "Cobrar de novo o responsável do setor",
    unit: "minutos",
    min: 1,
    max: 1440,
    grupo: "avisos",
  },
  {
    chave: "tempo_notificacao_admin",
    label: "Avisar o número do administrador: cliente pendente",
    unit: "minutos",
    min: 1,
    max: 1440,
    grupo: "avisos",
  },
  {
    chave: "intervalo_repeticao_notificacao_admin",
    label: "Cobrar de novo o número do administrador",
    unit: "minutos",
    min: 1,
    max: 1440,
    grupo: "avisos",
  },
  {
    chave: "tempo_encerramento_automatico",
    label: "Encerrar atendimento parado por inatividade",
    unit: "minutos",
    min: 1,
    max: 10080,
    grupo: "encerramento",
  },
];

const MOTIVO_SEM_STATUS = "Não foi possível confirmar se este tempo está em uso.";

/** Uma linha de public.status_tempos(): motivo null = o tempo faz efeito hoje. */
export interface StatusTempo {
  chave: string;
  motivo: string | null;
  /** Clientes que já passaram desse tempo (só no aviso ao responsável). */
  afetados: number | null;
}

interface LinhaConfig {
  chave: string;
  valor: string | null;
  descricao: string | null;
}

export interface TempoRow extends TempoMeta {
  /** null = chave ausente em system_config (não configurada). Nunca falseie como 0. */
  valor: number | null;
  descricao: string | null;
  /** true só quando o banco confirmou que o tempo faz efeito hoje. */
  emUso: boolean;
  /** Presente = o ajuste não tem efeito hoje (ou não deu para confirmar); a tela mostra o motivo. */
  inativo?: string;
  afetados: number | null;
}

/**
 * Junta valores e status. `status` null = a consulta de status falhou: a tela
 * ainda mostra e edita os valores, mas não afirma que algum deles está em uso.
 */
export function montarTempos(
  linhas: readonly LinhaConfig[],
  status: readonly StatusTempo[] | null,
): TempoRow[] {
  const porChave = new Map(linhas.map((l) => [l.chave, l]));
  const statusPorChave = new Map((status ?? []).map((s) => [s.chave, s]));
  return TEMPOS.map((meta) => {
    const linha = porChave.get(meta.chave);
    const n = Number.parseInt((linha?.valor ?? "").trim(), 10);
    const st = statusPorChave.get(meta.chave);
    const inativo = st ? (st.motivo ?? undefined) : MOTIVO_SEM_STATUS;
    return {
      ...meta,
      valor: Number.isFinite(n) ? n : null,
      descricao: linha?.descricao ?? null,
      emUso: inativo === undefined,
      inativo,
      afetados: st?.afetados ?? null,
    };
  });
}

/** Mesmo teto do LIMIT em public.status_tempos(): acima disso o banco para de contar. */
const TETO_AFETADOS = 500;

/** Frase da fila do aviso ao responsável; null quando não há ninguém para mostrar. */
export function textoAfetados(afetados: number | null, emUso: boolean): string | null {
  if (afetados == null || afetados <= 0) return null;
  const um = afetados === 1;
  const qtd = afetados >= TETO_AFETADOS ? `${TETO_AFETADOS} ou mais` : String(afetados);
  const base = `Hoje ${qtd} ${um ? "cliente já passou" : "clientes já passaram"} desse tempo.`;
  if (emUso) return base;
  return `${base} Se ligar, ${um ? "ele gera" : "todos geram"} aviso.`;
}

export async function fetchTempos(): Promise<TempoRow[]> {
  const [cfg, st] = await Promise.all([
    supabase
      .from("system_config")
      .select("chave, valor, descricao")
      .in(
        "chave",
        TEMPOS.map((t) => t.chave),
      ),
    supabase.rpc("status_tempos"),
  ]);
  if (cfg.error) throw cfg.error;
  // Falha no status não pode esconder os valores: mostra sem confirmar uso.
  if (st.error) console.error("status_tempos falhou:", st.error.message);
  return montarTempos(cfg.data ?? [], st.error ? null : (st.data ?? []));
}

export async function updateTempo(chave: string, valor: number) {
  const { data: auth } = await supabase.auth.getUser();
  // `.select()` é obrigatório aqui: sem ele um UPDATE que não casa nenhuma linha
  // volta sem erro e o save "dá certo" sem gravar nada — foi exatamente esse
  // silêncio que escondeu a aba Tempos zerada.
  const { data, error } = await supabase
    .from("system_config")
    .update({ valor: String(valor), updated_by: auth.user?.id ?? null })
    .eq("chave", chave)
    .select("chave");
  if (error) throw error;
  if (data && data.length > 0) return;

  // Nada gravado: ou a linha não existe, ou a RLS barrou (só dono/administrador
  // altera). Se dá para ler a linha, o problema é permissão.
  const { data: existe } = await supabase
    .from("system_config")
    .select("chave")
    .eq("chave", chave)
    .maybeSingle();
  throw new Error(
    existe
      ? "Só dono ou administrador pode alterar os tempos."
      : `Configuração "${chave}" não existe em system_config — nada foi salvo.`,
  );
}
