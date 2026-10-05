import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const BUCKET_MIDIA = "mensagens-midia";
const EXPIRES_IN = 900; // 15 min

/**
 * Gera URL assinada (15 min) para um path do bucket `mensagens-midia`.
 * Cache: staleTime 13min, gcTime 16min — segura no cache mesmo após URL expirar
 * para evitar regerar em remontagens curtas.
 */
export function useSignedMediaUrl(storagePath: string | null | undefined) {
  return useQuery({
    queryKey: ["signed-url", storagePath],
    enabled: !!storagePath,
    staleTime: 13 * 60 * 1000,
    gcTime: 16 * 60 * 1000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from(BUCKET_MIDIA)
        .createSignedUrl(storagePath as string, EXPIRES_IN);
      if (error) throw error;
      return data.signedUrl;
    },
  });
}
