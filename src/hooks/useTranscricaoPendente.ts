import { useEffect, useState, type RefObject } from "react";
import type { RichMessageComposerHandle } from "@/components/inbox/RichMessageComposer";

/**
 * Segura o texto transcrito até o RichMessageComposer voltar a existir.
 *
 * A barra de gravação SUBSTITUI o composer no DOM; no instante em que a
 * transcrição chega, `composerRef.current` ainda é null (o composer só
 * remonta quando `recordedAudio` vira null). Inserir via efeito garante que
 * o ref já foi religado no commit do remount.
 */
export function useTranscricaoPendente(
  composerRef: RefObject<RichMessageComposerHandle | null>,
): (texto: string) => void {
  const [pendente, setPendente] = useState<string | null>(null);

  useEffect(() => {
    if (pendente === null) return;
    composerRef.current?.insertText(pendente);
    setPendente(null);
  }, [pendente, composerRef]);

  return setPendente;
}
