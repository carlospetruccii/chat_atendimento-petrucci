// Sons e notificações do navegador (estilo WhatsApp Web).
//
// Os sons são sintetizados via Web Audio API — nenhum arquivo .mp3/.wav é
// necessário, funciona offline e são dois timbres claramente diferentes:
//  - mensagem  → "pop" suave de duas notas
//  - pendência → beep triplo ascendente, mais chamativo
//
// Tudo aqui toca só no navegador; as funções são no-op no SSR.

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  return audioCtx;
}

/**
 * Navegadores bloqueiam áudio até o primeiro gesto do usuário. Chame isto
 * dentro de um handler de clique/tecla para "destravar" o contexto de áudio.
 */
export function unlockAudio(): void {
  const ctx = getCtx();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
}

function tone(
  ctx: AudioContext,
  freq: number,
  startAt: number,
  duration: number,
  gain: number,
  type: OscillatorType = "sine",
): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(g);
  g.connect(ctx.destination);
  const t0 = ctx.currentTime + startAt;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.start(t0);
  osc.stop(t0 + duration + 0.03);
}

/** Som de mensagem nova: duas notas curtas e suaves. */
export function playMessageSound(): void {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  tone(ctx, 880, 0, 0.12, 0.14, "sine");
  tone(ctx, 1174, 0.1, 0.16, 0.11, "sine");
}

/** Som de pendência: beep triplo ascendente, mais urgente. */
export function playPendingSound(): void {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  tone(ctx, 660, 0, 0.13, 0.13, "triangle");
  tone(ctx, 660, 0.17, 0.13, 0.13, "triangle");
  tone(ctx, 990, 0.34, 0.22, 0.15, "triangle");
}

/** Pede permissão de notificação, se ainda não foi decidida. Seguro no SSR. */
export function requestNotificationPermission(): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

/** true se a aba está em primeiro plano e visível. */
export function isDocumentVisible(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible";
}

/**
 * Mostra uma notificação do navegador (se permitido). `tag` faz a nova
 * notificação substituir a anterior da mesma conversa/pendência.
 */
export function showBrowserNotification(
  title: string,
  body: string,
  tag: string,
  onClick?: () => void,
): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, {
      body,
      tag,
      icon: "/favicon.ico",
    });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch {
    // Alguns navegadores exigem Service Worker para notificações persistentes;
    // se falhar, o som já cumpriu o aviso.
  }
}
