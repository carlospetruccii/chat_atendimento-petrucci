import * as React from "react";

/** Mesmo valor do `md:` do Tailwind. Mudar aqui exige mudar lá. */
export const MOBILE_BREAKPOINT = 768;

/**
 * Escuta uma media query.
 *
 * ATENÇÃO — isto é para COMPORTAMENTO, não para layout.
 *
 * O app é renderizado no servidor, onde não existe `window`. O primeiro paint
 * sai sempre com o valor `false`, e só depois o efeito corrige. Se você decidir
 * layout com este hook, o celular pinta a versão desktop e "pula" — visível e
 * feio justamente nas telas pesadas (Inbox).
 *
 * Para layout use as classes do Tailwind (`hidden md:flex`, `md:w-[360px]`):
 * o CSS já chega certo no primeiro byte, sem pulo.
 *
 * Use este hook quando a decisão NÃO dá para expressar em CSS, por exemplo:
 *   - `<Sheet side="bottom">` no celular vs `side="right"` no desktop (prop);
 *   - interceptar o botão Voltar do Android para fechar um painel;
 *   - não montar um componente caro que ninguém vê no celular.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false);

  React.useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** `true` abaixo de 768px. Leia o aviso de `useMediaQuery` antes de usar. */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
}

/**
 * `true` só depois da hidratação. Serve para NÃO renderizar no servidor algo
 * que depende de medir a tela, evitando divergência de marcação.
 */
export function useHasMounted(): boolean {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * `true` quando o aparelho digita por teclado de tela (celular/tablet).
 *
 * Serve para COMPORTAMENTO de tecla, não para layout. Em teclado de tela o
 * Enter é a tecla de pular linha e não existe Shift+Enter: interceptar o Enter
 * para enviar rouba a única forma de escrever mais de um parágrafo. Nesses
 * aparelhos o envio fica só no botão.
 *
 * `pointer: coarse` (dedo, não mouse) é o sinal certo aqui — largura de tela
 * não é: uma janela estreita no desktop continua com teclado físico.
 */
export function useHasSoftKeyboard(): boolean {
  return useMediaQuery("(pointer: coarse)");
}
