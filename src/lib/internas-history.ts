import { dateLabel, dayKeySP } from "./inbox-history";
import type { MensagemInterna } from "./internas-queries";

/**
 * Itens renderizáveis do chat interno. Mais simples ainda que o de grupo: a
 * conversa é 1:1 e contínua, então só existe separador de DIA — não há
 * separador de atendimento (não há atendimento) nem autores múltiplos por lado.
 */
export type ConversaInternaItem =
  | { kind: "date-separator"; key: string; label: string }
  | {
      kind: "message";
      key: string;
      message: MensagemInterna;
      /** Minha mensagem → bolha à direita. */
      minha: boolean;
      /** Sequência do mesmo autor: espaçamento menor e sem repetir o nome. */
      colada: boolean;
    };

/**
 * Intercala separadores de dia e marca sequências do mesmo autor.
 * `messages` precisa vir em ordem ASC por createdAt.
 */
export function agruparMensagensInternas(
  messages: MensagemInterna[],
  meuUserId: string | null,
): ConversaInternaItem[] {
  const items: ConversaInternaItem[] = [];
  let ultimoDia: string | null = null;
  let ultimoAutor: string | null = null;

  for (const m of messages) {
    const dia = dayKeySP(m.createdAt);
    if (dia !== ultimoDia) {
      items.push({
        kind: "date-separator",
        key: `date-${dia}`,
        label: dateLabel(m.createdAt),
      });
      ultimoDia = dia;
      // Depois de um separador de dia o bloco de autor sempre reinicia.
      ultimoAutor = null;
    }

    const mesmoAutor = m.senderUserId === ultimoAutor;
    items.push({
      kind: "message",
      key: m.id,
      message: m,
      minha: m.senderUserId === meuUserId,
      colada: mesmoAutor,
    });
    ultimoAutor = m.senderUserId;
  }

  return items;
}

/** Iniciais para o avatar (no máximo duas letras). */
export function iniciaisDoNome(nome: string): string {
  return nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
}

/**
 * Ordena e deduplica mensagens por id, mantendo ASC por createdAt.
 * `id` desempata para o append em tempo real não embaralhar mensagens que
 * chegam com o mesmo carimbo.
 */
export function dedupeAndSortInternas(
  prev: MensagemInterna[],
  incoming: MensagemInterna[],
): MensagemInterna[] {
  if (incoming.length === 0) return prev;
  const map = new Map<string, MensagemInterna>();
  for (const m of prev) map.set(m.id, m);
  for (const m of incoming) map.set(m.id, m);
  return Array.from(map.values()).sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
