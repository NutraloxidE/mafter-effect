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
  renderGate?: {
    shouldRender: (nowMs: number, msPerFrame: number) => boolean;
    recordRenderCost: (costMs: number) => void;
  };
  /**
   * §11.5.2 declick を renderGate から独立させるための音声専用コールバック（省略可）。
   * renderGate が視覚描画を間引いても frame が進むたびに必ず呼ぶ（renderFrame とは別・呼び出し
   * コストが軽いことが前提）。未指定なら従来と完全一致（editor preview はこのループを共有する
   * ため無指定時は無影響）。
   */
  onFrameAudio?: (frame: number) => void;
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
    // §16.2/§16.2b フリーズ対策: renderFrame（DomRenderer 経由で alpha 合成等を呼ぶ）が同期例外を
    // 投げると、catch が無ければこの tick が末尾の requestAnimationFrame(tick) 再スケジュールに
    // 届かず、再生が二度と進まない恒久フリーズになる（bundle player / editor Preview 共有ループ）。
    // try/finally で「例外が起きても playing なら必ず次 rAF を予約する」を保証し、自己修復させる。
    try {
      const msPerFrame = 1000 / options.fps;
      const elapsed = now - lastRafMs;
      const advance = Math.floor(elapsed / msPerFrame);
      if (advance > 0) {
        lastRafMs = now - (elapsed % msPerFrame);
        if (options.shouldHold?.()) {
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
            options.onFrameAudio?.(lastFrame);
            const gen = ++renderGen;
            const renderStart = performance.now();
            void Promise.resolve(options.renderFrame(lastFrame))
              .catch((err) => console.error("previewPlaybackLoop: renderFrame failed", err))
              .finally(() => {
                options.renderGate?.recordRenderCost(performance.now() - renderStart);
                if (gen === renderGen) options.onPlaybackEnd();
              });
            return;
          }
        }
        currentFrame = next;
        options.onFrameChange(currentFrame);
        options.onFrameAudio?.(currentFrame);
        if (options.renderGate?.shouldRender(now, msPerFrame) !== false) {
          const gen = ++renderGen;
          const renderStart = performance.now();
          void Promise.resolve(options.renderFrame(currentFrame))
            .catch((err) => console.error("previewPlaybackLoop: renderFrame failed", err))
            .finally(() => {
              options.renderGate?.recordRenderCost(performance.now() - renderStart);
              if (gen !== renderGen) return;
            });
        }
      }
    } catch (err) {
      console.error("previewPlaybackLoop: tick failed", err);
    } finally {
      if (playing) rafId = requestAnimationFrame(tick);
    }
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
    // 同じ理由（上の runPreviewPlaybackLoop 参照）: onFrameChange/shouldHold が同期例外を投げても
    // 次 rAF を必ず予約し、恒久フリーズにしない。
    try {
      const msPerFrame = 1000 / options.fps;
      const elapsed = now - lastRafMs;
      const advance = Math.floor(elapsed / msPerFrame);
      if (advance > 0) {
        lastRafMs = now - (elapsed % msPerFrame);
        if (options.shouldHold?.()) {
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
    } catch (err) {
      console.error("previewFrameClock: tick failed", err);
    } finally {
      if (playing) rafId = requestAnimationFrame(tick);
    }
  };

  rafId = requestAnimationFrame(tick);
  return () => {
    playing = false;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    lastRafMs = null;
  };
}
