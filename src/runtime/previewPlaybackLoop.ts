/** §28.3 / §27.12 — Draft 再生用 RAF ループ（React render effect バイパス）。
 * 外部依存ゼロの純粋な rAF ループなので editor Preview パネルと bundle player の両方が
 * 同一実装を共有する（§11.4 双方向同期 shouldHold 込みで preview↔bundle 一致・単一の正）。 */

export interface PreviewPlaybackLoopOptions {
  fps: number;
  loopStart: number;
  loopEnd: number;
  loop: boolean;
  initialFrame: number;
  renderFrame: (frame: number) => void | Promise<void>;
  onFrameChange: (frame: number) => void;
  onPlaybackEnd: () => void;
  /**
   * true の間は frame を進めない(映像ピクセル待ち)。
   * wall-clock の lastRafMs は通常どおり消費し、解除時のフレームジャンプを防ぐ。
   */
  shouldHold?: () => boolean;
}

/** BundlePlayer 同型: フレームスキップ + 最新 frame のみ render。stop 関数を返す。 */
export function runPreviewPlaybackLoop(options: PreviewPlaybackLoopOptions): () => void {
  let playing = true;
  let currentFrame = options.initialFrame;
  let lastRafMs: number | null = null;
  let rafId: number | null = null;
  let renderGen = 0;

  const tick = (now: number) => {
    if (!playing) return;
    if (lastRafMs === null) {
      lastRafMs = now;
      rafId = requestAnimationFrame(tick);
      return;
    }
    const msPerFrame = 1000 / options.fps;
    const elapsed = now - lastRafMs;
    const advance = Math.floor(elapsed / msPerFrame);
    if (advance > 0) {
      lastRafMs = now - (elapsed % msPerFrame);
      if (options.shouldHold?.()) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      let next = currentFrame + advance;
      const { loopStart, loopEnd, loop } = options;
      if (next >= loopEnd) {
        if (loop) {
          next = loopStart + ((next - loopStart) % Math.max(1, loopEnd - loopStart));
        } else {
          playing = false;
          const lastFrame = Math.max(loopStart, loopEnd - 1);
          currentFrame = lastFrame;
          options.onFrameChange(lastFrame);
          const gen = ++renderGen;
          void Promise.resolve(options.renderFrame(lastFrame)).finally(() => {
            if (gen === renderGen) options.onPlaybackEnd();
          });
          return;
        }
      }
      currentFrame = next;
      options.onFrameChange(currentFrame);
      const gen = ++renderGen;
      void Promise.resolve(options.renderFrame(currentFrame)).finally(() => {
        if (gen !== renderGen) return;
      });
    }
    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
  return () => {
    playing = false;
    renderGen += 1;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    lastRafMs = null;
  };
}

/** Best / 非 Draft 再生 — frame 進行のみ（render は React effect 担当）。 */
export function runPreviewFrameClock(options: Omit<PreviewPlaybackLoopOptions, "renderFrame">): () => void {
  let playing = true;
  let currentFrame = options.initialFrame;
  let lastRafMs: number | null = null;
  let rafId: number | null = null;

  const tick = (now: number) => {
    if (!playing) return;
    if (lastRafMs === null) {
      lastRafMs = now;
      rafId = requestAnimationFrame(tick);
      return;
    }
    const msPerFrame = 1000 / options.fps;
    const elapsed = now - lastRafMs;
    const advance = Math.floor(elapsed / msPerFrame);
    if (advance > 0) {
      lastRafMs = now - (elapsed % msPerFrame);
      if (options.shouldHold?.()) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      let next = currentFrame + advance;
      const { loopStart, loopEnd, loop } = options;
      if (next >= loopEnd) {
        if (loop) {
          next = loopStart + ((next - loopStart) % Math.max(1, loopEnd - loopStart));
        } else {
          playing = false;
          const lastFrame = Math.max(loopStart, loopEnd - 1);
          currentFrame = lastFrame;
          options.onFrameChange(lastFrame);
          options.onPlaybackEnd();
          return;
        }
      }
      currentFrame = next;
      options.onFrameChange(currentFrame);
    }
    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
  return () => {
    playing = false;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    lastRafMs = null;
  };
}
