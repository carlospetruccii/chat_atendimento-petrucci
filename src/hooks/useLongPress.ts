import { useCallback, useEffect, useRef } from "react";

const DURACAO_MS = 450;
/** Arrastar mais que isso é rolagem/seleção de texto, não toque longo. */
const TOLERANCIA_PX = 10;

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

/**
 * "Segurar" um elemento (toque longo no celular, clique com o direito no
 * desktop). É o gesto que o WhatsApp usa para entrar no modo de seleção, então é
 * o que a pessoa vai tentar aqui.
 *
 * Cancela ao rolar: no celular, todo scroll começa com um pointerdown na lista,
 * e sem essa guarda rolar a conversa abriria a seleção sem ninguém pedir.
 */
export function useLongPress(acao: () => void): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origem = useRef<{ x: number; y: number } | null>(null);
  const acaoRef = useRef(acao);
  acaoRef.current = acao;

  const cancelar = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origem.current = null;
  }, []);

  useEffect(() => cancelar, [cancelar]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Botão direito já é tratado por onContextMenu.
    if (e.button !== 0) return;
    origem.current = { x: e.clientX, y: e.clientY };
    timer.current = setTimeout(() => {
      timer.current = null;
      acaoRef.current();
    }, DURACAO_MS);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const o = origem.current;
      if (!o || !timer.current) return;
      if (Math.abs(e.clientX - o.x) > TOLERANCIA_PX || Math.abs(e.clientY - o.y) > TOLERANCIA_PX) {
        cancelar();
      }
    },
    [cancelar],
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      cancelar();
      acaoRef.current();
    },
    [cancelar],
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: cancelar,
    onPointerLeave: cancelar,
    onPointerCancel: cancelar,
    onContextMenu,
  };
}
