import { SETOR_TODOS, type OpcaoSetor, type SetorFiltro } from "@/lib/inbox-setor";

interface Props {
  value: SetorFiltro;
  opcoes: OpcaoSetor[];
  /** Conversas com mensagem não lida por setor (id do setor → quantidade). */
  naoLidas: Record<SetorFiltro, number>;
  onChange: (value: SetorFiltro) => void;
}

const FALLBACK_COR = "#64748b";

const POR_LINHA = 3;

/**
 * Filtro por setor, em pills (seleção única). Mostra, em cada setor, quantas
 * conversas têm mensagem não lida — quem atende vê onde está a fila sem abrir
 * nada. Cabem 3 pills por linha, em até 2 linhas; o que passar disso fica à
 * direita e aparece rolando a faixa para o lado.
 */
export function InboxSetorFilter({ value, opcoes, naoLidas, onChange }: Props) {
  const todas: OpcaoSetor[] = [{ id: SETOR_TODOS, nome: "Todos os setores", cor: null }, ...opcoes];
  const linhas = todas.length > POR_LINHA ? 2 : 1;
  return (
    <div
      role="radiogroup"
      aria-label="Filtrar conversas por setor"
      // Cada coluna ocupa 1/3 da largura (descontando os 2 espaços entre elas).
      className={`grid grid-flow-col auto-cols-[calc((100%_-_0.75rem)/3)] gap-1.5 overflow-x-auto pb-1 snap-x [scrollbar-width:thin] ${
        linhas === 2 ? "grid-rows-2" : "grid-rows-1"
      }`}
    >
      {todas.map(({ id, nome, cor }) => {
        const ativo = value === id;
        const count = id === SETOR_TODOS ? 0 : (naoLidas[id] ?? 0);
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={ativo}
            onClick={() => onChange(id)}
            title={nome}
            className={`flex min-w-0 snap-start items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              ativo
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
            }`}
          >
            {id !== SETOR_TODOS && (
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: cor ?? FALLBACK_COR }}
              />
            )}
            <span className="min-w-0 flex-1 truncate text-left">{nome}</span>
            {count > 0 && (
              <span
                aria-label={`${count} com mensagem não lida`}
                className="ml-0.5 shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-bold leading-[15px] text-primary-foreground"
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
