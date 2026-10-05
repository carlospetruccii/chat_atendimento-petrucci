import { useEffect, useState } from "react";

/**
 * Relógio que avança sozinho, para a tela reavaliar prazos que expiram enquanto
 * ela está aberta.
 *
 * Sem isso, "apagar para todos" continuaria oferecido depois de 60h numa aba que
 * ninguém recarregou — e a ação falharia em silêncio no WhatsApp. 30s é
 * suficiente: os dois prazos (15 min e 60h) são ordens de grandeza maiores, e a
 * margem em janelas-whatsapp.ts absorve a defasagem.
 */
export function useAgora(intervaloMs = 30_000): number {
  const [agora, setAgora] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), intervaloMs);
    return () => clearInterval(t);
  }, [intervaloMs]);

  return agora;
}
