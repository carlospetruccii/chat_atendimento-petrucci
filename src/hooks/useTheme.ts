import { useEffect } from "react";

export type Theme = "light";

const STORAGE_KEY = "bpmax-theme";

function applyLightTheme() {
  if (typeof document === "undefined") return;
  document.documentElement.classList.remove("dark");
}

// Só tema claro; migra quem tinha "dark" salvo (CSS .dark fica intacto em styles.css)
export function useTheme() {
  useEffect(() => {
    applyLightTheme();
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return { theme: "light" as const };
}
