export type DirecaoOrdem = "cima" | "baixo";

// noMenu = aparece no menu do bot (ativo e não é o departamento de sistema).
export interface ItemOrdem {
  id: string;
  noMenu: boolean;
}

/**
 * Nova ordem dos ids depois de subir/descer um departamento no menu do bot.
 * Troca com o vizinho mais próximo que também aparece no menu — trocar com um
 * inativo não mudaria nada para o cliente. Devolve null quando não há o que
 * mover (ponta do menu, id ausente ou item fora do menu). Não altera a lista.
 */
export function moverDepartamento(
  itens: readonly ItemOrdem[],
  id: string,
  direcao: DirecaoOrdem,
): string[] | null {
  const de = itens.findIndex((i) => i.id === id);
  if (de === -1 || !itens[de].noMenu) return null;

  const passo = direcao === "cima" ? -1 : 1;
  let para = de + passo;
  while (para >= 0 && para < itens.length && !itens[para].noMenu) para += passo;
  if (para < 0 || para >= itens.length) return null;

  const ids = itens.map((i) => i.id);
  [ids[de], ids[para]] = [ids[para], ids[de]];
  return ids;
}
