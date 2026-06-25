import { useCallback, useEffect, useRef, type RefObject } from "react";

export interface DragEdgeAutoScrollOptions {
  /** 上下端からこの距離以内でスクロール開始（px） */
  edgeSize?: number;
  /** 端ぴったり時の最大スクロール量（px/frame） */
  maxSpeed?: number;
  /** false を返す dragover ではスクロールしない */
  isActive?: (e: React.DragEvent) => boolean;
}

/**
 * ドラッグ中、スクロール容器の上下端付近にカーソルがある間だけ自動スクロールする。
 * capture フェーズの dragover で子要素上も追跡する。
 */
export function useDragEdgeAutoScroll(
  containerRef: RefObject<HTMLElement | null>,
  options: DragEdgeAutoScrollOptions = {},
) {
  const { edgeSize = 28, maxSpeed = 14, isActive } = options;
  const clientYRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    clientYRef.current = null;
  }, []);

  const tick = useCallback(() => {
    const el = containerRef.current;
    const y = clientYRef.current;

    if (!el || y === null) {
      rafRef.current = null;
      return;
    }

    const rect = el.getBoundingClientRect();
    if (y >= rect.top && y <= rect.bottom) {
      let delta = 0;
      if (y < rect.top + edgeSize) {
        const t = Math.min(1, (rect.top + edgeSize - y) / edgeSize);
        delta = -maxSpeed * t;
      } else if (y > rect.bottom - edgeSize) {
        const t = Math.min(1, (y - (rect.bottom - edgeSize)) / edgeSize);
        delta = maxSpeed * t;
      }

      if (delta !== 0) {
        const maxScroll = el.scrollHeight - el.clientHeight;
        if (maxScroll > 0) {
          el.scrollTop = Math.max(0, Math.min(maxScroll, el.scrollTop + delta));
        }
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [containerRef, edgeSize, maxSpeed]);

  const start = useCallback(() => {
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [tick]);

  const onDragOverCapture = useCallback(
    (e: React.DragEvent) => {
      if (isActive && !isActive(e)) return;
      clientYRef.current = e.clientY;
      start();
    },
    [isActive, start],
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      const related = e.relatedTarget as Node | null;
      const el = containerRef.current;
      if (el && related && el.contains(related)) return;
      stop();
    },
    [containerRef, stop],
  );

  useEffect(() => {
    window.addEventListener("dragend", stop);
    return () => {
      window.removeEventListener("dragend", stop);
      stop();
    };
  }, [stop]);

  return {
    onDragOverCapture,
    onDragLeave,
    onDrop: stop,
    onDragEnd: stop,
  };
}
