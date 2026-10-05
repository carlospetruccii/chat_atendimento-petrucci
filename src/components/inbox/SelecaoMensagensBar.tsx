import { Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SelecaoMensagensBarProps {
  quantas: number;
  onCancelar: () => void;
  onApagar: () => void;
}

/**
 * Barra do modo de seleção, no topo da conversa. Fica sticky porque a pessoa
 * seleciona mensagens rolando a conversa: um botão que sai da tela junto com o
 * scroll obrigaria a voltar ao topo para concluir. O top deixa a barra logo
 * abaixo do cabeçalho flutuante da conversa, que cobre o topo da área rolável.
 *
 * `-mx`/`px` sangram a barra até a borda do container de mensagens — precisa
 * bater com o padding dele (`p-3 sm:p-6`) em cada breakpoint, senão sobra uma
 * faixa da cor errada nas laterais.
 */
export function SelecaoMensagensBar({ quantas, onCancelar, onApagar }: SelecaoMensagensBarProps) {
  return (
    <div className="sticky top-[3.75rem] z-20 sm:top-[4.5rem] -mx-3 mb-3 flex items-center justify-between gap-3 border-b border-border bg-card/95 px-3 py-2 backdrop-blur sm:-mx-6 sm:px-6">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={onCancelar}
          aria-label="Sair da seleção"
          title="Sair da seleção"
          className="touch-target-mobile h-8 w-8"
        >
          <X className="h-4 w-4" strokeWidth={1.5} />
        </Button>
        <span className="text-sm font-medium">
          {quantas} {quantas === 1 ? "selecionada" : "selecionadas"}
        </span>
      </div>

      <Button
        size="sm"
        onClick={onApagar}
        className="bg-[#DC2626] text-white hover:bg-[#DC2626]/90"
      >
        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
        Apagar para todos
      </Button>
    </div>
  );
}
