import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export interface AuthSessionState {
  session: Session | null;
  /** true até resolvermos a sessão no cliente (evita "piscar" o login). */
  loading: boolean;
}

/**
 * Sessão REAL do Supabase Auth.
 *
 * A sessão vive no localStorage (client-only — ver integrations/supabase/client.ts),
 * por isso resolvemos tudo no cliente: no primeiro render `loading=true`, e assim que
 * `getSession()` responde (ou um evento de auth chega) atualizamos.
 *
 * IMPORTANTE: ligar o login NÃO acorda o multi-empresa. A trava
 * `auth_enforcement_enabled` continua 'false' e as regras de RLS seguem liberando
 * tudo (modo interno de uma empresa só). O login só faz o backend saber QUEM envia.
 */
export function useAuthSession(): AuthSessionState {
  const [state, setState] = useState<AuthSessionState>({ session: null, loading: true });

  useEffect(() => {
    let ativo = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!ativo) return;
      setState({ session: data.session ?? null, loading: false });
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!ativo) return;
      setState({ session: session ?? null, loading: false });
    });

    return () => {
      ativo = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}
