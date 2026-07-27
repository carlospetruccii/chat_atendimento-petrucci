/**
 * Decide se a aba Grupos deve sincronizar com o WhatsApp ao abrir.
 *
 * Por que existe sincronização automática em vez de um botão: grupo com
 * conversa já aparece sozinho (o webhook cria a linha na primeira mensagem,
 * igual ao chat individual). O que NÃO aparece sozinho é:
 *   - grupo em que te adicionaram e ninguém falou ainda (grupo calado) — sem
 *     sincronizar, não há como mandar a primeira mensagem;
 *   - grupo do qual você saiu / foi removido — é a sincronização que marca
 *     `ativo = false` e tira da lista.
 *
 * Rodar a cada abertura de aba seria desperdício (a lista de grupos muda
 * raramente e cada chamada gasta cota da instância uazapi), então há uma trava
 * por tempo baseada em `synced_at`. Função pura para ser testável.
 */

/** Janela mínima entre sincronizações automáticas. */
export const INTERVALO_SYNC_MS = 15 * 60_000; // 15 minutos

export interface EstadoSync {
  /** Grupos já carregados do banco (com o carimbo da última sincronização). */
  grupos: readonly { syncedAt: string | null }[];
  /** Agora, em ms (injetado para o teste não depender do relógio). */
  agoraMs: number;
  /** Já há uma sincronização em andamento. */
  sincronizando: boolean;
  /** Esta montagem da tela já tentou sincronizar (evita laço em caso de erro). */
  jaTentou: boolean;
}

export function deveSincronizar(estado: EstadoSync): boolean {
  const { grupos, agoraMs, sincronizando, jaTentou } = estado;
  if (sincronizando || jaTentou) return false;

  // Nenhum grupo conhecido: primeira carga, sincroniza para popular a lista.
  if (grupos.length === 0) return true;

  const carimbos = grupos
    .map((g) => (g.syncedAt ? Date.parse(g.syncedAt) : Number.NaN))
    .filter((t) => Number.isFinite(t));

  // Há grupo sem carimbo (ex.: criado pelo webhook, nunca sincronizado):
  // vale sincronizar para completar nome/tópico/participantes.
  if (carimbos.length < grupos.length) return true;

  const maisRecente = Math.max(...carimbos);
  return agoraMs - maisRecente > INTERVALO_SYNC_MS;
}
