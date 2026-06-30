// Cliente Supabase com service role para Edge Functions.
// SECURITY: bypassa RLS. Usar apenas em contexto server-side confiável.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

let _client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (_client) return _client;

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !serviceKey) {
    throw new Error(
      "Variáveis SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY ausentes no ambiente da Edge Function.",
    );
  }

  _client = createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return _client;
}
