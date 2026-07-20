import { useRef, useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_WINDOW_MS = 300;
const BUTTON_ZOOM_STEP = 0.75;

interface Point {
  x: number;
  y: number;
}

interface Props {
  src: string;
  alt: string;
}

function getDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getMidpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function ZoomableImage({ src, alt }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(MIN_SCALE);
  const [position, setPosition] = useState<Point>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const activePointers = useRef(new Map<number, Point>());
  const dragOrigin = useRef<{ pointer: Point; position: Point } | null>(null);
  const pinchOrigin = useRef<{ distance: number; scale: number } | null>(null);
  const lastTapAt = useRef(0);

  const clamp = (nextScale: number, point: Point): Point => {
    const container = containerRef.current;
    if (!container) return point;
    const { width, height } = container.getBoundingClientRect();
    const maxX = (width * (nextScale - 1)) / 2;
    const maxY = (height * (nextScale - 1)) / 2;
    return {
      x: Math.min(maxX, Math.max(-maxX, point.x)),
      y: Math.min(maxY, Math.max(-maxY, point.y)),
    };
  };

  const anchorFromClient = (clientX: number, clientY: number): Point => {
    const container = containerRef.current;
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };

  const zoomTo = (nextScaleRaw: number, anchor: Point) => {
    const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScaleRaw));
    if (nextScale === MIN_SCALE) {
      setScale(MIN_SCALE);
      setPosition({ x: 0, y: 0 });
      return;
    }
    setScale((prevScale) => {
      const ratio = nextScale / prevScale;
      setPosition((prevPos) =>
        clamp(nextScale, {
          x: anchor.x - (anchor.x - prevPos.x) * ratio,
          y: anchor.y - (anchor.y - prevPos.y) * ratio,
        }),
      );
      return nextScale;
    });
  };

  const toggleZoomAt = (clientX: number, clientY: number) => {
    if (scale > MIN_SCALE) {
      setScale(MIN_SCALE);
      setPosition({ x: 0, y: 0 });
    } else {
      zoomTo(DOUBLE_TAP_SCALE, anchorFromClient(clientX, clientY));
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.01);
    zoomTo(scale * factor, anchorFromClient(e.clientX, e.clientY));
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    toggleZoomAt(e.clientX, e.clientY);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.current.size === 2) {
      dragOrigin.current = null;
      setIsDragging(false);
      const [a, b] = [...activePointers.current.values()];
      pinchOrigin.current = { distance: getDistance(a, b), scale };
      return;
    }

    if (e.pointerType !== "mouse") {
      const now = Date.now();
      if (now - lastTapAt.current < DOUBLE_TAP_WINDOW_MS) {
        toggleZoomAt(e.clientX, e.clientY);
        lastTapAt.current = 0;
      } else {
        lastTapAt.current = now;
      }
    }
    if (scale > MIN_SCALE) {
      dragOrigin.current = { pointer: { x: e.clientX, y: e.clientY }, position };
      setIsDragging(true);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!activePointers.current.has(e.pointerId)) return;
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.current.size === 2 && pinchOrigin.current) {
      const [a, b] = [...activePointers.current.values()];
      const ratio = getDistance(a, b) / pinchOrigin.current.distance;
      const mid = getMidpoint(a, b);
      zoomTo(pinchOrigin.current.scale * ratio, anchorFromClient(mid.x, mid.y));
      return;
    }

    if (dragOrigin.current) {
      const dx = e.clientX - dragOrigin.current.pointer.x;
      const dy = e.clientY - dragOrigin.current.pointer.y;
      setPosition(
        clamp(scale, {
          x: dragOrigin.current.position.x + dx,
          y: dragOrigin.current.position.y + dy,
        }),
      );
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    activePointers.current.delete(e.pointerId);
    if (activePointers.current.size < 2) pinchOrigin.current = null;
    if (activePointers.current.size === 1 && scale > MIN_SCALE) {
      const [remaining] = [...activePointers.current.values()];
      dragOrigin.current = { pointer: remaining, position };
    } else if (activePointers.current.size === 0) {
      dragOrigin.current = null;
      setIsDragging(false);
    }
  };

  const zoomByStep = (direction: 1 | -1) =>
    zoomTo(scale + direction * BUTTON_ZOOM_STEP, { x: 0, y: 0 });
  const reset = () => {
    setScale(MIN_SCALE);
    setPosition({ x: 0, y: 0 });
  };

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      <div
        ref={containerRef}
        className="flex h-full w-full touch-none select-none items-center justify-center"
        style={{ cursor: scale > MIN_SCALE ? (isDragging ? "grabbing" : "grab") : "zoom-in" }}
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={endPointer}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          className="max-h-full w-auto max-w-full object-contain"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transition: isDragging || pinchOrigin.current ? "none" : "transform 150ms ease-out",
          }}
        />
      </div>

      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/60 p-1 backdrop-blur">
        <button
          type="button"
          onClick={() => zoomByStep(-1)}
          disabled={scale <= MIN_SCALE}
          className="rounded-full p-2 text-white transition hover:bg-white/20 disabled:opacity-40"
          aria-label="Diminuir zoom"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={scale === MIN_SCALE}
          className="rounded-full p-2 text-white transition hover:bg-white/20 disabled:opacity-40"
          aria-label="Redefinir zoom"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => zoomByStep(1)}
          disabled={scale >= MAX_SCALE}
          className="rounded-full p-2 text-white transition hover:bg-white/20 disabled:opacity-40"
          aria-label="Aumentar zoom"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
