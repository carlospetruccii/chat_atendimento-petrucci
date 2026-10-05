import { describe, expect, test, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { audioTranscrevivel } from "@/hooks/useTranscricaoAudio";

describe("audioTranscrevivel", () => {
  test("devolve o storage_path de um áudio baixado", () => {
    expect(audioTranscrevivel({ tipo: "audio", mediaMetadata: { storage_path: "c/a.mp3" } })).toBe(
      "c/a.mp3",
    );
  });

  test("ignora mensagem que não é áudio", () => {
    expect(
      audioTranscrevivel({ tipo: "video", mediaMetadata: { storage_path: "c/a.mp4" } }),
    ).toBeNull();
  });

  test("ignora áudio ainda baixando ou cujo download falhou", () => {
    expect(audioTranscrevivel({ tipo: "audio", mediaMetadata: null })).toBeNull();
    expect(audioTranscrevivel({ tipo: "audio", mediaMetadata: { storage_path: "" } })).toBeNull();
    expect(
      audioTranscrevivel({
        tipo: "audio",
        mediaMetadata: { storage_path: "c/a.mp3", download_falhou: true },
      }),
    ).toBeNull();
  });
});
