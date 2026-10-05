import type { InboxMessage, AtendimentoStatus } from "./inbox-queries";

const TZ = "America/Sao_Paulo";

const DAY_KEY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const SHORT_DAY_FMT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TZ,
  day: "2-digit",
  month: "2-digit",
});
const FULL_FMT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TZ,
  day: "numeric",
  month: "long",
});
const FULL_WITH_YEAR_FMT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TZ,
  day: "numeric",
  month: "long",
  year: "numeric",
});
const YEAR_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
});

/** Chave estável (YYYY-MM-DD em America/Sao_Paulo) para agrupar por dia. */
export function dayKeySP(iso: string): string {
  return DAY_KEY_FMT.format(new Date(iso));
}

/** "Hoje", "Ontem", "12 de maio" ou "12 de maio de 2024". TZ São Paulo. */
export function dateLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const ymd = dayKeySP(iso);
  const todayKey = dayKeySP(today.toISOString());
  if (ymd === todayKey) return "Hoje";

  const yest = new Date(today);
  yest.setDate(yest.getDate() - 1);
  if (ymd === dayKeySP(yest.toISOString())) return "Ontem";

  const yearMsg = YEAR_FMT.format(d);
  const yearNow = YEAR_FMT.format(today);
  return yearMsg === yearNow ? FULL_FMT.format(d) : FULL_WITH_YEAR_FMT.format(d);
}

/** "12/05" curto (TZ São Paulo). */
export function shortDateSP(iso: string): string {
  return SHORT_DAY_FMT.format(new Date(iso));
}

export interface AtendimentoMeta {
  id: string;
  status: AtendimentoStatus;
  createdAt: string;
  closedAt: string | null;
  isCurrent: boolean;
}

export type ChatLoadState = "loading" | "error" | "empty" | "messages";

/** Decide o estado visível do painel sem mascarar falha de rede como chat vazio. */
export function chatLoadState(params: {
  isLoadingInitial: boolean;
  error: unknown;
  itemCount: number;
}): ChatLoadState {
  if (params.isLoadingInitial) return "loading";
  if (params.error) return "error";
  return params.itemCount === 0 ? "empty" : "messages";
}

export type ChatItem =
  | { kind: "date-separator"; key: string; label: string }
  | {
      kind: "atendimento-separator";
      key: string;
      atendimentoId: string;
      label: string;
      isCurrent: boolean;
    }
  | { kind: "message"; key: string; message: InboxMessage; isFirstOfAtendimento: boolean };

function atendimentoLabel(meta: AtendimentoMeta): string {
  if (meta.isCurrent) return "Atendimento atual";
  if (meta.status === "encerrado" && meta.closedAt) {
    return `Atendimento anterior — encerrado em ${shortDateSP(meta.closedAt)}`;
  }
  return `Atendimento de ${shortDateSP(meta.createdAt)}`;
}

/**
 * Agrupa mensagens (já em ordem ASC por created_at) intercalando separadores de dia
 * e separadores de atendimento. Se há apenas 1 atendimento em cena, não emite separador
 * de atendimento. Se o atendimento atual não tem nenhuma mensagem mas há anteriores,
 * acrescenta o separador "Atendimento atual" no fim.
 */
export function agruparMensagens(
  messages: InboxMessage[],
  atendimentos: AtendimentoMeta[],
): ChatItem[] {
  const metaById = new Map(atendimentos.map((a) => [a.id, a]));
  const distinctIds = new Set(messages.map((m) => m.atendimentoId));
  // Garante que o atendimento atual entre na contagem mesmo sem msgs.
  const currentMeta = atendimentos.find((a) => a.isCurrent);
  if (currentMeta) distinctIds.add(currentMeta.id);
  const showAtendimentoSeparators = distinctIds.size > 1;

  const items: ChatItem[] = [];
  let lastDayKey: string | null = null;
  let lastAtendimentoId: string | null = null;

  for (const m of messages) {
    const dayKey = dayKeySP(m.createdAt);

    if (showAtendimentoSeparators && m.atendimentoId !== lastAtendimentoId) {
      const meta = metaById.get(m.atendimentoId);
      if (meta) {
        items.push({
          kind: "atendimento-separator",
          key: `at-${meta.id}`,
          atendimentoId: meta.id,
          label: atendimentoLabel(meta),
          isCurrent: meta.isCurrent,
        });
      }
      // Reset day-key: forçar separador de data dentro do novo atendimento
      // só se o dia já mudou em relação à mensagem anterior.
      if (lastDayKey !== dayKey) {
        items.push({
          kind: "date-separator",
          key: `date-${meta?.id ?? "x"}-${dayKey}`,
          label: dateLabel(m.createdAt),
        });
      }
      lastAtendimentoId = m.atendimentoId;
      lastDayKey = dayKey;
      items.push({
        kind: "message",
        key: m.id,
        message: m,
        isFirstOfAtendimento: true,
      });
      continue;
    }

    if (lastDayKey !== dayKey) {
      items.push({
        kind: "date-separator",
        key: `date-${m.atendimentoId}-${dayKey}`,
        label: dateLabel(m.createdAt),
      });
      lastDayKey = dayKey;
    }

    items.push({
      kind: "message",
      key: m.id,
      message: m,
      isFirstOfAtendimento: lastAtendimentoId !== m.atendimentoId,
    });
    lastAtendimentoId = m.atendimentoId;
  }

  // Se o atendimento atual ainda não apareceu em nenhuma mensagem mas existem anteriores,
  // anexa o separador "Atendimento atual" no fim.
  if (showAtendimentoSeparators && currentMeta && lastAtendimentoId !== currentMeta.id) {
    items.push({
      kind: "atendimento-separator",
      key: `at-${currentMeta.id}`,
      atendimentoId: currentMeta.id,
      label: atendimentoLabel(currentMeta),
      isCurrent: true,
    });
  }

  return items;
}
