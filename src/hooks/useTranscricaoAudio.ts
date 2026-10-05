import { useQuery, useQueryClient } from "@tanstack/react-query";
import { transcreverAudioArmazenado } from "@/lib/ai-texto";

// Transcrição de áudio recebido. O pedido nasce no menu da bolha e o texto
// aparece embaixo do player (MediaAudio) — componentes separados, então o
// cache do react-query é o elo: os dois usam a mesma chave pelo storage_path.
// Nada é gravado no banco: fechar a aba e voltar pede de novo.

const TRINTA_MIN = 30 * 60 * 1000;

function chave(storagePath: string) {
  return ["transcricao-audio", storagePath] as const;
}

/** storage_path do áudio quando a mensagem é um áudio já baixado; senão null. */
export function audioTranscrevivel(mensagem: {
  tipo: string;
  mediaMetadata: Record<string, unknown> | null;
}): string | null {
  if (mensagem.tipo !== "audio") return null;
  const meta = mensagem.mediaMetadata ?? {};
  if (meta.download_falhou === true) return null;
  return typeof meta.storage_path === "string" && meta.storage_path !== ""
    ? meta.storage_path
    : null;
}

/** Lê o estado da transcrição (não dispara nada sozinho). */
export function useTranscricaoAudio(storagePath: string) {
  return useQuery({
    queryKey: chave(storagePath),
    queryFn: () => transcreverAudioArmazenado(storagePath),
    enabled: false,
    staleTime: Infinity,
    gcTime: TRINTA_MIN,
    retry: false,
  });
}

/** Dispara a transcrição; reaproveita o resultado se já existir. */
export function usePedirTranscricao() {
  const queryClient = useQueryClient();
  return (storagePath: string) =>
    queryClient.fetchQuery({
      queryKey: chave(storagePath),
      queryFn: () => transcreverAudioArmazenado(storagePath),
      staleTime: Infinity,
      gcTime: TRINTA_MIN,
      retry: false,
    });
}
