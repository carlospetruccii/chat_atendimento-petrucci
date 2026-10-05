import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { useSignedMediaUrl } from "@/hooks/useSignedMediaUrl";
import { useTranscricaoAudio } from "@/hooks/useTranscricaoAudio";
import { MediaLoading } from "./MediaLoading";
import { MediaError } from "./MediaError";

// 1x -> 1.5x -> 2x -> volta. É o mesmo conjunto que o WhatsApp oferece.
const SPEED_STEPS = [1, 1.5, 2] as const;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function MediaAudio({
  storagePath,
  durationSeconds,
}: {
  storagePath: string;
  durationSeconds?: number | null;
}) {
  const { data: url, isLoading, error } = useSignedMediaUrl(storagePath);
  const transcricao = useTranscricaoAudio(storagePath);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationSeconds ?? 0);
  const [speedIndex, setSpeedIndex] = useState(0);
  // A URL assinada vale 15 min e o hook não re-busca sozinho. Quem fica meia
  // hora relendo o histórico e só então toca um áudio antigo cai numa URL morta.
  // Sem este estado o botão de play simplesmente não fazia nada, para sempre —
  // o <audio controls> nativo que ele substituiu pelo menos dava sinal visual.
  const [falhou, setFalhou] = useState(false);

  // Enquanto o dedo arrasta a bolinha, o `timeupdate` do elemento continua
  // chegando e sobrescreveria a posição — a barra pulava contra o dedo. Este ref
  // (e não estado) porque o valor é lido dentro de um handler, sem re-render.
  const arrastando = useRef(false);

  // Nova URL assinada = nova mensagem de áudio: reinicia o player do zero.
  // A duração entra também: sem ela o player mostrava a duração da mensagem
  // ANTERIOR até o `loadedmetadata` da nova chegar.
  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(durationSeconds ?? 0);
    setFalhou(false);
  }, [url, durationSeconds]);

  if (isLoading) return <MediaLoading tipo="audio" />;
  if (error || !url || falhou) return <MediaError tipo="audio" />;

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      // `play()` devolve Promise. Dois toques rápidos (o padrão no celular)
      // fazem o segundo cair no `pause()` antes do primeiro começar de fato, e
      // o navegador REJEITA com AbortError — isso é o gesto do usuário, não
      // falha, e é o único caso que se engole. Qualquer outra rejeição é mídia
      // que não toca, e aí a pessoa precisa VER que quebrou.
      // `isPlaying` não se conserta aqui: quem manda nele são os eventos
      // `play`/`pause` do próprio elemento.
      audio.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setFalhou(true);
      });
    } else {
      audio.pause();
    }
  }

  function onSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const value = Number(e.target.value);
    setCurrentTime(value);
    if (audioRef.current) audioRef.current.currentTime = value;
  }

  function cycleSpeed() {
    const nextIndex = (speedIndex + 1) % SPEED_STEPS.length;
    setSpeedIndex(nextIndex);
    if (audioRef.current) audioRef.current.playbackRate = SPEED_STEPS[nextIndex];
  }

  const total = duration || 0;

  return (
    // O <audio controls> nativo não dá pra redimensionar: a barra de progresso
    // do navegador é fininha demais pro dedo, e não tem botão de velocidade no
    // celular. Por isso o player é desenhado aqui (play, barra, velocidade) e o
    // <audio> só toca por baixo, escondido — mesma URL assinada de sempre.
    <div className="flex w-full max-w-full flex-col gap-1">
      <div className="flex w-full max-w-full items-center gap-2">
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          className="hidden"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onLoadedMetadata={(e) => {
            const real = e.currentTarget.duration;
            setDuration(Number.isFinite(real) ? real : (durationSeconds ?? 0));
          }}
          onError={() => setFalhou(true)}
          onTimeUpdate={(e) => {
            if (arrastando.current) return;
            setCurrentTime(e.currentTarget.currentTime);
          }}
        />

        <button
          type="button"
          onClick={togglePlay}
          aria-label={isPlaying ? "Pausar áudio" : "Tocar áudio"}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/10 dark:bg-white/10"
        >
          {isPlaying ? (
            <Pause className="h-4 w-4" strokeWidth={1.5} fill="currentColor" />
          ) : (
            <Play className="ml-0.5 h-4 w-4" strokeWidth={1.5} fill="currentColor" />
          )}
        </button>

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          {/* h-6 = 24px de alvo de toque (mínimo pedido mesmo pra barra fina).
            O trilho pintado (::-webkit-slider-runnable-track / -moz-range-track)
            fica com 4px de altura por baixo — só a marca visual é fina, a área
            que responde ao toque é o input inteiro. */}
          <input
            type="range"
            min={0}
            max={total}
            step={0.1}
            value={Math.min(currentTime, total)}
            onChange={onSeek}
            onPointerDown={() => (arrastando.current = true)}
            onPointerUp={() => (arrastando.current = false)}
            onPointerCancel={() => (arrastando.current = false)}
            aria-label="Posição do áudio"
            className="h-6 w-full min-w-0 cursor-pointer appearance-none bg-transparent
            [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-black/15
            dark:[&::-webkit-slider-runnable-track]:bg-white/20
            [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-current
            [&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-black/15
            dark:[&::-moz-range-track]:bg-white/20
            [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-current"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] opacity-70">
              {formatTime(currentTime)} / {formatTime(total)}
            </span>
            <button
              type="button"
              onClick={cycleSpeed}
              className="touch-target-mobile -my-1 shrink-0 rounded px-1.5 text-[10px] font-semibold opacity-80"
              aria-label={`Velocidade de reprodução: ${SPEED_STEPS[speedIndex]}x. Toque para mudar.`}
            >
              {SPEED_STEPS[speedIndex]}x
            </button>
          </div>
        </div>
      </div>
      <TranscricaoTexto
        carregando={transcricao.fetchStatus === "fetching"}
        texto={transcricao.data ?? null}
      />
    </div>
  );
}

function TranscricaoTexto({ carregando, texto }: { carregando: boolean; texto: string | null }) {
  if (carregando) {
    return <p className="text-xs italic opacity-70">Transcrevendo áudio…</p>;
  }
  if (!texto) return null;
  // Texto vira nó de texto do React (escapado) — nada de HTML vindo da IA.
  return (
    <p className="whitespace-pre-wrap break-words border-t border-black/10 pt-1 text-sm dark:border-white/10">
      {texto}
    </p>
  );
}
