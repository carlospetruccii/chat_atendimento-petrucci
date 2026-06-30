import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderState = "idle" | "recording" | "paused" | "encoding";

export interface RecordedAudio {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
}

const PREFERRED_MIMES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/mp4",
];

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of PREFERRED_MIMES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      // ignore
    }
  }
  return "";
}

const MAX_SECONDS = 120;

export function useAudioRecorder() {
  const [state, setState] = useState<RecorderState>("idle");
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const accumulatedRef = useRef(0); // segundos acumulados antes da pausa atual
  const segmentStartRef = useRef(0); // ms quando começou o segmento atual
  const tickRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const resolveRef = useRef<((v: RecordedAudio | null) => void) | null>(null);

  const cleanup = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    recorderRef.current = null;
    chunksRef.current = [];
    accumulatedRef.current = 0;
    segmentStartRef.current = 0;
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const startTick = useCallback(() => {
    if (tickRef.current !== null) return;
    tickRef.current = window.setInterval(() => {
      const elapsed = accumulatedRef.current +
        Math.round((Date.now() - segmentStartRef.current) / 1000);
      setDurationSeconds(elapsed);
      if (elapsed >= MAX_SECONDS) {
        const rec = recorderRef.current;
        if (rec && rec.state !== "inactive") {
          try {
            rec.stop();
          } catch {
            // ignore
          }
        }
      }
    }, 250);
  }, []);

  const stopTick = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (state !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Gravação de áudio não suportada neste navegador.");
      throw new Error("MediaRecorder indisponível");
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "permissão negada";
      setError(`Não foi possível acessar o microfone: ${msg}`);
      throw e;
    }
    const mime = pickMime();
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    streamRef.current = stream;
    recorderRef.current = rec;
    chunksRef.current = [];
    cancelledRef.current = false;
    accumulatedRef.current = 0;

    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    rec.onstop = () => {
      // Soma o último segmento se ainda estava rodando
      if (segmentStartRef.current > 0) {
        accumulatedRef.current += Math.round((Date.now() - segmentStartRef.current) / 1000);
        segmentStartRef.current = 0;
      }
      const dur = Math.max(0, accumulatedRef.current);
      const type = rec.mimeType || mime || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      cleanup();
      setDurationSeconds(0);
      setState("idle");
      const resolver = resolveRef.current;
      resolveRef.current = null;
      if (resolver) {
        if (cancelledRef.current || blob.size === 0) resolver(null);
        else resolver({ blob, mimeType: type, durationSeconds: dur });
      }
    };

    segmentStartRef.current = Date.now();
    rec.start();
    setState("recording");
    setDurationSeconds(0);
    startTick();
  }, [cleanup, startTick, state]);

  const pause = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "recording") return;
    try {
      rec.pause();
    } catch {
      return;
    }
    accumulatedRef.current += Math.round((Date.now() - segmentStartRef.current) / 1000);
    segmentStartRef.current = 0;
    stopTick();
    setDurationSeconds(accumulatedRef.current);
    setState("paused");
  }, [stopTick]);

  const resume = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "paused") return;
    try {
      rec.resume();
    } catch {
      return;
    }
    segmentStartRef.current = Date.now();
    setState("recording");
    startTick();
  }, [startTick]);

  // Para a gravação SEM cancelar; resolve com o blob para revisão.
  const finish = useCallback((): Promise<RecordedAudio | null> => {
    return new Promise((resolve) => {
      const rec = recorderRef.current;
      if (!rec || rec.state === "inactive") {
        resolve(null);
        return;
      }
      resolveRef.current = resolve;
      cancelledRef.current = false;
      stopTick();
      setState("encoding");
      try {
        rec.stop();
      } catch {
        cleanup();
        setState("idle");
        resolve(null);
      }
    });
  }, [cleanup, stopTick]);

  const cancel = useCallback(() => {
    const rec = recorderRef.current;
    cancelledRef.current = true;
    stopTick();
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        // ignore
      }
    } else {
      cleanup();
      setState("idle");
      setDurationSeconds(0);
    }
  }, [cleanup, stopTick]);

  return {
    state,
    durationSeconds,
    error,
    start,
    pause,
    resume,
    finish,
    cancel,
    maxSeconds: MAX_SECONDS,
  };
}
