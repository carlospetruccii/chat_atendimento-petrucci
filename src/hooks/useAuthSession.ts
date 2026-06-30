import type { Session } from "@supabase/supabase-js";

type State = { session: Session | null; loading: boolean };

const OPEN_SESSION_STATE: State = { session: null, loading: false };

export function useAuthSession() {
  return OPEN_SESSION_STATE;
}
