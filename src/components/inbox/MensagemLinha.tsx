import { cn } from "@/lib/utils";
import { useLongPress } from "@/hooks/useLongPress";

interface MensagemLinhaProps {
  mensagemId: string;
  /** Âncora da Linha do Tempo — só na primeira mensagem de cada atendimento. */
  atendimentoAnchor?: string;
  className: string;
  modoSelecao: boolean;
  selecionada: boolean;
  /** Entrar no modo de seleção com esta mensagem (segurar / clique direito). */
  onSegurar: () => void;
  /** Marcar/desmarcar, já dentro do modo de seleção. */
  onToqueSelecao: () => void;
  children: React.ReactNode;
}

/**
 * Container de uma mensagem na conversa. Existe como componente separado por um
 * motivo técnico: o gesto de segurar é um hook (useLongPress) e a lista de
 * mensagens é um .map() — hook dentro de map não é possível.
 *
 * Dentro do modo de seleção o toque longo é desligado e o clique simples passa a
 * marcar/desmarcar, que é o comportamento do WhatsApp. Deixar os dois ativos
 * faria um segundo toque longo reiniciar a seleção e perder o que já estava
 * marcado.
 */
export function MensagemLinha({
  mensagemId,
  atendimentoAnchor,
  className,
  modoSelecao,
  selecionada,
  onSegurar,
  onToqueSelecao,
  children,
}: MensagemLinhaProps) {
  const longPress = useLongPress(onSegurar);

  return (
    <div
      data-message-id={mensagemId}
      data-atendimento-anchor={atendimentoAnchor}
      className={cn(
        className,
        modoSelecao && "relative cursor-pointer rounded-md transition-colors",
        selecionada && "bg-primary/10 ring-1 ring-primary/30",
      )}
      {...(modoSelecao ? {} : longPress)}
      onClick={modoSelecao ? onToqueSelecao : undefined}
    >
      {children}
      {/* Escudo por cima da mensagem enquanto se está selecionando. Sem ele,
          tocar numa imagem abria o zoom e num documento disparava o download —
          E marcava a mensagem, porque o clique sobe até o container. Um
          `pointer-events-none` nos filhos não serve: mataria também o clique que
          precisa chegar ao container. O escudo é filho, então o clique nele
          borbulha normal e vira seleção. */}
      {modoSelecao && <span className="absolute inset-0 z-10" aria-hidden />}
    </div>
  );
}
