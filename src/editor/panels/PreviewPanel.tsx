import { useEffect, useRef, useState } from "react";
import { resolve, type ExpressionEvaluator } from "../../runtime/resolve";
import { DomRenderer } from "../../runtime/DomRenderer";
import { ExpressionEngine } from "../../runtime/expressionEngine";
import { HtmlCompPlayer } from "../../runtime/htmlComp";
import { ModuleLoader } from "../../runtime/moduleLoader";
import { IndexedDbFs } from "../../fs/IndexedDbFs";
import { compositionDir } from "../../core/paths";
import { currentTimelineComp, useEditorStore } from "../store";
import type { HtmlComposition } from "../../core/schema";

// M2: expression engine + HTML comp player は preview インスタンスに 1 つ。
const _previewFs = new IndexedDbFs("mafter-effect-fs");
const _previewLoader = new ModuleLoader(_previewFs);
const _exprEngine = new ExpressionEngine(_previewLoader);
const _htmlLoader = new ModuleLoader(_previewFs);
const _htmlPlayer = new HtmlCompPlayer(_htmlLoader);

export function PreviewPanel() {
  const project = useEditorStore((s) => s.project);
  const compId = useEditorStore((s) => s.currentCompId);
  const frame = useEditorStore((s) => s.currentFrame);
  const setFrame = useEditorStore((s) => s.setFrame);
  const pluginsVersion = useEditorStore((s) => s.pluginsVersion);

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<DomRenderer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // prepare() 完了などで再描画を促すための tick（ref の更新は再レンダーを起こさないため）。
  const [renderTick, setRenderTick] = useState(0);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const frameRef = useRef(frame);

  // M2: expression evaluator ref（prepare() が非同期なので ref で保持）
  const evaluatorRef = useRef<ExpressionEvaluator | undefined>(undefined);

  const comp = currentTimelineComp(project, compId);
  frameRef.current = frame;

  // mount/remount renderer when comp changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !comp) return;
    const r = new DomRenderer();
    r.setHtmlPlayer(_htmlPlayer);
    r.mount(el, comp);
    rendererRef.current = r;
    return () => {
      r.dispose();
      rendererRef.current = null;
    };
  }, [comp?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // HTML comp メタを毎 project 変更で DomRenderer に注入し、§9 expression と §7 html module を preload。
  // prepare() は非async なので、完了したら renderTick を進めて再描画する。
  useEffect(() => {
    if (!comp) return;
    const htmlComps = (project?.compositions ?? []).filter(
      (c): c is HtmlComposition => c.kind === "html",
    );
    rendererRef.current?.setHtmlComps(new Map(htmlComps.map((c) => [c.id, c])));
    // evaluatorRef はリセットしない。古い evaluator をそのまま使い続け、
    // prepare 完了後に新しい evaluator に差し替える（リセットするとその間の
    // フレームで expression が fallback 値にスナップしてチラつく）。
    void Promise.all([
      _exprEngine.prepare(comp).then(() => {
        evaluatorRef.current = _exprEngine.makeEvaluator(comp);
      }),
      _htmlPlayer.prepare(htmlComps, (id) => `${compositionDir(id)}/script.js`),
    ]).then(() => setRenderTick((t) => t + 1));
  }, [comp?.id, project]); // eslint-disable-line react-hooks/exhaustive-deps

  // plugin がロードされたら再描画をトリガー（DomRenderer / ExpressionEngine は globalPluginRegistry を lazy 参照）
  useEffect(() => {
    setRenderTick((t) => t + 1);
  }, [pluginsVersion]);

  // render on frame / project / prepare 完了（background は DomRenderer が mount で comp から取得済み）
  useEffect(() => {
    if (!comp || !rendererRef.current) return;
    rendererRef.current.renderFrame(
      resolve(comp, frame, { expressions: evaluatorRef.current }),
      frame,
    );
  }, [comp, frame, renderTick]);

  // scale-to-fit: 固定 px の comp ステージを利用可能領域に収まるよう transform: scale する。
  useEffect(() => {
    if (!comp) return;
    const fit = fitRef.current;
    const stage = stageRef.current;
    if (!fit || !stage) return;
    const apply = () => {
      const aw = fit.clientWidth;
      const ah = fit.clientHeight;
      if (aw === 0 || ah === 0) return;
      const scale = Math.min(aw / comp.width, ah / comp.height);
      stage.style.transform = `scale(${scale})`;
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(fit);
    return () => ro.disconnect();
  }, [comp?.id, comp?.width, comp?.height]); // eslint-disable-line react-hooks/exhaustive-deps

  // playback clock — 決定論 frame ステップ（§11.2 スタイル、rAF ではなく frame 刻み）
  useEffect(() => {
    if (!isPlaying || !comp) return;
    const fps = comp.fps;
    const duration = comp.duration;
    const msPerFrame = 1000 / fps;

    const tick = (now: number) => {
      if (lastTimeRef.current === null) {
        lastTimeRef.current = now;
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const elapsed = now - lastTimeRef.current;
      const framesToAdvance = Math.floor(elapsed / msPerFrame);
      if (framesToAdvance > 0) {
        lastTimeRef.current = now - (elapsed % msPerFrame);
        const next = frameRef.current + framesToAdvance;
        if (next >= duration) {
          setIsPlaying(false);
          setFrame(0);
        } else {
          setFrame(next);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    lastTimeRef.current = null;
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastTimeRef.current = null;
    };
  }, [isPlaying, comp, setFrame]);

  const togglePlay = () => setIsPlaying((p) => !p);

  // keyboard: Space = play/pause
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const fps = comp?.fps ?? 30;
  const timeSec = (frame / fps).toFixed(2);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#1a1a1a" }}>
      {/* toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", background: "#222", borderBottom: "1px solid #333", flexShrink: 0 }}>
        <button onClick={togglePlay} style={btnStyle}>{isPlaying ? "⏸" : "▶"}</button>
        <button onClick={() => setFrame(0)} style={btnStyle}>⏮</button>
        <span style={{ fontSize: 11, color: "#aaa", fontVariantNumeric: "tabular-nums" }}>
          F{frame} / {timeSec}s
        </span>
        {comp && (
          <span style={{ fontSize: 10, color: "#666", marginLeft: "auto" }}>
            {comp.width}×{comp.height} @ {comp.fps}fps
          </span>
        )}
      </div>
      {/* canvas area — fit box が利用領域、stage を scale-to-fit して中央寄せ */}
      <div ref={fitRef} style={{ flex: 1, position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {comp ? (
          <div
            ref={stageRef}
            style={{
              position: "relative",
              width: comp.width,
              height: comp.height,
              flexShrink: 0,
              background: "#000",
              boxShadow: "0 0 0 1px #444",
              transformOrigin: "center center",
              overflow: "hidden",
            }}
          >
            <div ref={containerRef} style={{ width: comp.width, height: comp.height }} />
          </div>
        ) : (
          <div style={{ color: "#555", fontSize: 13 }}>No composition — create a project first</div>
        )}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#333",
  border: "1px solid #555",
  color: "#ccc",
  borderRadius: 3,
  padding: "2px 8px",
  cursor: "pointer",
  fontSize: 12,
};
