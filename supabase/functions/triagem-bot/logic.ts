// Lógica pura do bot de triagem (sem banco, sem rede) — testada em logic.test.ts.

// Rodapé da lista interativa ("Ver setores") no WhatsApp.
export const LIST_TITULO = "Parabrisas Petrucci";

export interface DepartamentoOrdenavel { id: string; nome: string; ordem: number; }

// Ordem do menu = coluna `ordem` (definida na aba Departamentos); empate pelo
// nome. O número que o cliente digita é a posição nesta lista, então menu,
// lista interativa e leitura da resposta usam sempre o mesmo array.
export function ordenarDepartamentos<T extends DepartamentoOrdenavel>(deps: readonly T[]): T[] {
  return [...deps].sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, "pt-BR"));
}
