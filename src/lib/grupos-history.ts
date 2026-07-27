import { dateLabel, dayKeySP } from "./inbox-history";
import type { GrupoMessage } from "./grupos-queries";

/**
 * Itens renderizáveis do chat de grupo. Bem mais simples que o do individual:
 * grupo é uma conversa contínua, então só existe separador de DIA — não há
 * separador de atendimento porque não há atendimento.
 */
export type GrupoChatItem =
  | { kind: "date-separator"; key: string; label: string }
  | {
      kind: "message";
      key: string;
      message: GrupoMessage;
      /** Primeira mensagem seguida do mesmo autor: só ela mostra o nome. */
      mostrarAutor: boolean;
      /** Espaçamento menor quando é sequência do mesmo autor. */
      colada: boolean;
    };

/** Identidade do autor, para decidir agrupamento de bolhas consecutivas. */
function chaveDoAutor(m: GrupoMessage): string {
  if (m.direction === "outbound") return `out:${m.senderType}:${m.sentByUserId ?? "-"}`;
  return `in:${m.participanteNumero ?? m.participanteNome ?? "-"}`;
}

/**
 * Intercala separadores de dia e marca quais mensagens abrem um novo bloco de
 * autor. `messages` precisa vir em ordem ASC por createdAt.
 */
export function agruparMensagensGrupo(messages: GrupoMessage[]): GrupoChatItem[] {
  const items: GrupoChatItem[] = [];
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
      // Depois de um separador de dia, o bloco de autor sempre reinicia.
      ultimoAutor = null;
    }

    const autor = chaveDoAutor(m);
    const mesmoAutor = autor === ultimoAutor;
    items.push({
      kind: "message",
      key: m.id,
      message: m,
      mostrarAutor: !mesmoAutor,
      colada: mesmoAutor,
    });
    ultimoAutor = autor;
  }

  return items;
}

// ————————————————————————————————————————————————————————————————
// Identificação visual do autor
// ————————————————————————————————————————————————————————————————

// Paleta fixa (estilo WhatsApp): cada participante recebe sempre a mesma cor,
// derivada do número — nada é guardado no banco e a cor não muda entre sessões.
const CORES_PARTICIPANTE = [
  "#1F7AEC",
  "#D9376E",
  "#00A884",
  "#B25FF1",
  "#E4A11B",
  "#0E9AA7",
  "#EA6A47",
  "#7A5AF8",
  "#2E9E5B",
  "#C3572C",
] as const;

/** Cor estável de um participante, derivada da chave (número ou nome). */
export function corDoParticipante(chave: string | null): string {
  if (!chave) return CORES_PARTICIPANTE[0];
  let hash = 0;
  for (let i = 0; i < chave.length; i++) {
    hash = (hash * 31 + chave.charCodeAt(i)) % 100000;
  }
  return CORES_PARTICIPANTE[hash % CORES_PARTICIPANTE.length];
}

/**
 * Rótulo do autor de uma mensagem de grupo.
 * Precedência do participante: contato do Google > nome público do WhatsApp >
 * número — a mesma do chat individual.
 */
export function autorDaMensagem(
  m: GrupoMessage,
  params: { meuUserId: string | null; nomesDeContato: Map<string, string> },
): string {
  if (m.direction === "outbound") {
    if (m.senderType === "sistema") return "Sistema";
    if (m.senderType === "externo") return "Fora do sistema";
    return m.sentByUserId === params.meuUserId ? "Você" : (m.sentByNome ?? "Atendente");
  }
  const numero = m.participanteNumero;
  if (numero) {
    return params.nomesDeContato.get(numero) ?? m.participanteNome ?? numero;
  }
  return m.participanteNome ?? "Participante";
}
