// TEMPORÁRIO: sondagem do gateway de IA do Lovable (deletar após uso).
// Descobre modelos disponíveis e valida endpoints de chat e transcrição.

const GUARD = "probe-almore-2026";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("k") !== GUARD) {
    return new Response("forbidden", { status: 403 });
  }

  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) {
    return Response.json({ error: "LOVABLE_API_KEY ausente" }, { status: 500 });
  }
  const auth = { Authorization: `Bearer ${key}` };
  const out: Record<string, unknown> = {};

  // 1. Lista de modelos
  try {
    const r = await fetch("https://ai.gateway.lovable.dev/v1/models", { headers: auth });
    out.models = { status: r.status, body: (await r.text()).slice(0, 4000) };
  } catch (e) {
    out.models = { error: String(e) };
  }

  // 2. Chat completion simples
  try {
    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: "Responda apenas: ok" }],
      }),
    });
    out.chat = { status: r.status, body: (await r.text()).slice(0, 2000) };
  } catch (e) {
    out.chat = { error: String(e) };
  }

  // 3. Endpoint de transcrição (WAV de silêncio, 0.2s, só pra validar rota/formato)
  try {
    const sampleRate = 8000;
    const samples = 1600;
    const dataSize = samples * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buf);
    const writeStr = (off: number, s: string) => {
      for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    v.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    writeStr(36, "data");
    v.setUint32(40, dataSize, true);

    const form = new FormData();
    form.append("file", new Blob([buf], { type: "audio/wav" }), "test.wav");
    form.append("model", "openai/gpt-4o-mini-transcribe");
    const r = await fetch("https://ai.gateway.lovable.dev/v1/audio/transcriptions", {
      method: "POST",
      headers: auth,
      body: form,
    });
    out.transcription = { status: r.status, body: (await r.text()).slice(0, 2000) };
  } catch (e) {
    out.transcription = { error: String(e) };
  }

  return Response.json(out);
});
