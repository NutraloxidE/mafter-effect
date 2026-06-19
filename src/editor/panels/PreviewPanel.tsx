import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolve, type ExpressionEvaluator } from "../../runtime/resolve";
import { DomRenderer } from "../../runtime/DomRenderer";
import { FontOutlineCache } from "../../runtime/fontOutlineCache";
import { ImageAssetCache } from "../../runtime/imageAssetCache";
import { ExpressionEngine } from "../../runtime/expressionEngine";
import { HtmlCompPlayer } from "../../runtime/htmlComp";
import { ModuleLoader } from "../../runtime/moduleLoader";
import { IndexedDbFs } from "../../fs/IndexedDbFs";
import { compositionDir } from "../../core/paths";
import {
  compWithTransformOverride,
  compWithObjectPatch,
  computeFitPan,
  computeFitZoom,
  resolutionProxyScale,
  screenToComp,
  zoomAtCursor,
  type ZoomMode,
} from "../previewViewer";
import {
  loadViewerSettings,
  saveViewerSettings,
  type PreviewViewerSettings,
} from "../previewViewerStorage";
import { currentTimelineComp, selectedObjects, useEditorStore } from "../store";
import type { HtmlComposition, TimelineComposition, Transform } from "../../core/schema";
import { PreviewViewerOverlay } from "./PreviewViewerOverlay";

const _previewFs = new IndexedDbFs("mafter-effect-fs");
const _previewLoader = new ModuleLoader(_previewFs);
const _exprEngine = new ExpressionEngine(_previewLoader);
const _htmlLoader = new ModuleLoader(_previewFs);
const _htmlPlayer = new HtmlCompPlayer(_htmlLoader);

// §21.1 SMPTE タイムコード（non-drop）
function framesToTimecode(frame: number, fps: number): string {
  const f = Math.max(1, Math.round(fps));
  const ff = ((frame % f) + f) % f;
  const totalSec = Math.floor(frame / f);
  const ss = ((totalSec % 60) + 60) % 60;
  const mm = (Math.floor(totalSec / 60) % 60 + 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const p2 = (n: number) => String(Math.abs(n)).padStart(2, "0");
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}:${p2(ff)}`;
}

const ZOOM_PRESETS: { label: string; mode: ZoomMode; zoom?: number }[] = [
  { label: "Fit", mode: "fit" },
  { label: "Fit ≤100%", mode: "fit100" },
  { label: "100%", mode: "manual", zoom: 1 },
  { label: "50%", mode: "manual", zoom: 0.5 },
  { label: "25%", mode: "manual", zoom: 0.25 },
  { label: "200%", mode: "manual", zoom: 2 },
  { label: "400%", mode: "manual", zoom: 4 },
];

export function PreviewPanel() {
  const project = useEditorStore((s) => s.project);
  const compId = useEditorStore((s) => s.currentCompId);
  const frame = useEditorStore((s) => s.currentFrame);
  const setFrame = useEditorStore((s) => s.setFrame);
  const setCurrentComp = useEditorStore((s) => s.setCurrentComp);
  const pluginsVersion = useEditorStore((s) => s.pluginsVersion);
  const selectedIds = useEditorStore((s) => s.selectedObjectIds);
  const updateObject = useEditorStore((s) => s.updateObject);
  const previewQualityEditing = useEditorStore((s) => s.previewQualityEditing);
  const setPreviewQuality = useEditorStore((s) => s.setPreviewQuality);
  const projectRevision = useEditorStore((s) => s.projectRevision);
  const previewOverride = useEditorStore((s) => s.previewOverride);

  const timelineComps = (project?.compositions ?? []).filter((c) => c.kind === "timeline");

  const isPlaying = useEditorStore((s) => s.isPlaying);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const togglePlay = useEditorStore((s) => s.togglePlay);

  const containerRef = useRef<HTMLDivElement>(null);
  const stageHostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<DomRenderer | null>(null);
  const fontCacheRef = useRef(new FontOutlineCache());
  const imageCacheRef = useRef(new ImageAssetCache());
  const textQualityRef = useRef<"draft" | "precise">("draft");
  const [renderTick, setRenderTick] = useState(0);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const frameRef = useRef(frame);
  const evaluatorRef = useRef<ExpressionEvaluator | undefined>(undefined);

  const [viewerSettings, setViewerSettings] = useState<PreviewViewerSettings>(() =>
    loadViewerSettings(compId),
  );
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });
  const [draftTransform, setDraftTransform] = useState<Transform | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [editingFrame, setEditingFrame] = useState(false);
  const [frameInput, setFrameInput] = useState("");

  const comp = currentTimelineComp(project, compId);
  frameRef.current = frame;

  const selected = useMemo(
    () => (comp && project ? selectedObjects(project, compId, selectedIds) : []),
    [comp, project, compId, selectedIds],
  );
  const primaryObject = selected[0] ?? null;

  const renderComp = useMemo(() => {
    if (!comp) return null;
    let c = comp;
    if (previewOverride) {
      c = compWithObjectPatch(c, previewOverride.objectId, previewOverride.patch);
    }
    if (draftTransform && primaryObject) {
      c = compWithTransformOverride(c, primaryObject.id, draftTransform);
    }
    return c;
  }, [comp, draftTransform, primaryObject?.id, previewOverride]);

  // §25.7 comp 切替時に設定を読み込む
  useEffect(() => {
    const loaded = loadViewerSettings(compId);
    setViewerSettings(loaded);
    setPreviewQuality(loaded.previewQuality);
    setDraftTransform(null);
  }, [compId, setPreviewQuality]);

  const patchSettings = useCallback(
    (patch: Partial<PreviewViewerSettings>) => {
      setViewerSettings((prev) => {
        const next = { ...prev, ...patch };
        saveViewerSettings(compId, next);
        if (patch.previewQuality) setPreviewQuality(patch.previewQuality);
        return next;
      });
    },
    [compId, setPreviewQuality],
  );

  const effectiveZoom = useMemo(() => {
    if (!comp || viewportSize.w === 0) return 1;
    if (viewerSettings.zoomMode === "fit") {
      return computeFitZoom(viewportSize.w, viewportSize.h, comp.width, comp.height);
    }
    if (viewerSettings.zoomMode === "fit100") {
      return computeFitZoom(viewportSize.w, viewportSize.h, comp.width, comp.height, true);
    }
    return viewerSettings.viewZoom;
  }, [comp, viewportSize, viewerSettings.zoomMode, viewerSettings.viewZoom]);

  const effectivePan = useMemo(() => {
    if (!comp || viewportSize.w === 0) return { x: 0, y: 0 };
    if (viewerSettings.zoomMode === "fit" || viewerSettings.zoomMode === "fit100") {
      return computeFitPan(viewportSize.w, viewportSize.h, comp.width, comp.height, effectiveZoom);
    }
    return viewerSettings.viewPan;
  }, [comp, effectiveZoom, viewportSize, viewerSettings.zoomMode, viewerSettings.viewPan]);

  const proxyScale = resolutionProxyScale(viewerSettings.resolutionProxy);

  // mount/remount renderer when comp changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !comp) return;
    const r = new DomRenderer();
    r.setHtmlPlayer(_htmlPlayer);
    r.setFontCache(fontCacheRef.current);
    r.setImageCache(imageCacheRef.current);
    r.setTextQuality(textQualityRef.current); // 生成時に現在の品質を反映（effect は値不変時 re-run しない）
    r.mount(el, comp);
    rendererRef.current = r;
    return () => {
      r.dispose();
      rendererRef.current = null;
    };
  }, [comp?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!comp) return;
    const htmlComps = (project?.compositions ?? []).filter(
      (c): c is HtmlComposition => c.kind === "html",
    );
    rendererRef.current?.setHtmlComps(new Map(htmlComps.map((c) => [c.id, c])));
    const timelineCompsForNesting = (project?.compositions ?? []).filter(
      (c): c is TimelineComposition => c.kind === "timeline" && c.id !== comp?.id,
    );
    rendererRef.current?.setTimelineComps(new Map(timelineCompsForNesting.map((c) => [c.id, c])));
    void Promise.all([
      _exprEngine.prepare(comp).then(() => {
        evaluatorRef.current = _exprEngine.makeEvaluator(comp);
      }),
      _htmlPlayer.prepare(htmlComps, (id) => `${compositionDir(id)}/script.js`),
    ]).then(() => setRenderTick((t) => t + 1));
  }, [comp?.id, project]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setRenderTick((t) => t + 1);
  }, [pluginsVersion]);

  // §26.4 asset フォントを preload
  useEffect(() => {
    if (!project) return;
    void Promise.all([
      fontCacheRef.current.loadFromProject(project, _previewFs),
      imageCacheRef.current.loadFromProject(project, _previewFs),
    ]).then(() => setRenderTick((t) => t + 1));
  }, [project]);

  const effectiveTextQuality =
    previewQualityEditing ? "draft" : viewerSettings.previewQuality;

  textQualityRef.current = effectiveTextQuality;
  useEffect(() => {
    rendererRef.current?.setTextQuality(effectiveTextQuality);
    setRenderTick((t) => t + 1);
  }, [effectiveTextQuality]);

  // undo/redo 等で project が差し替わったら draft を捨てて DomRenderer を必ず再描画
  useEffect(() => {
    setDraftTransform(null);
    setRenderTick((t) => t + 1);
  }, [projectRevision]);

  useEffect(() => {
    setRenderTick((t) => t + 1);
  }, [previewOverride]);

  // render on frame / project / draft transform
  useEffect(() => {
    if (!renderComp || !rendererRef.current) return;
    rendererRef.current.renderFrame(
      resolve(renderComp, frame, { expressions: evaluatorRef.current }),
      frame,
    );
  }, [renderComp, frame, renderTick, projectRevision]);

  // §25.2 解像度プロキシ: DomRenderer のラスタ解像度のみ変更（INV-2 scene 値不変）
  useEffect(() => {
    if (!comp || !rendererRef.current) return;
    const pw = Math.max(1, Math.round(comp.width * proxyScale));
    const ph = Math.max(1, Math.round(comp.height * proxyScale));
    rendererRef.current.resize(pw, ph);
    if (containerRef.current) {
      containerRef.current.style.width = `${pw}px`;
      containerRef.current.style.height = `${ph}px`;
      containerRef.current.style.transform = proxyScale < 1 ? `scale(${1 / proxyScale})` : "none";
      containerRef.current.style.transformOrigin = "0 0";
    }
  }, [comp?.width, comp?.height, proxyScale]);

  // viewport / host rect observer
  useEffect(() => {
    const fit = fitRef.current;
    const host = stageHostRef.current;
    if (!fit) return;
    const apply = () => {
      setViewportSize({ w: fit.clientWidth, h: fit.clientHeight });
      const r = host?.getBoundingClientRect();
      if (r) setHostRect({ left: r.left, top: r.top });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(fit);
    if (host) ro.observe(host);
    window.addEventListener("scroll", apply, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", apply, true);
    };
  }, []);

  // §25.6 ループ再生
  useEffect(() => {
    if (!isPlaying || !comp) return;
    const fps = comp.fps;
    const duration = comp.duration;
    const msPerFrame = 1000 / fps;
    const loop = viewerSettings.loop;

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
          if (loop) {
            setFrame(next % duration);
          } else {
            setPlaying(false);
            setFrame(0);
          }
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
  }, [isPlaying, comp, setFrame, setPlaying, viewerSettings.loop]);

  // §25.1 Ctrl+ホイールズーム / スペース+パン
  useEffect(() => {
    const fit = fitRef.current;
    if (!fit || !comp) return;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const host = stageHostRef.current?.getBoundingClientRect();
      if (!host) return;
      const cursor = screenToComp(e.clientX, e.clientY, host, effectiveZoom, effectivePan);
      const factor = Math.pow(1.1, -e.deltaY / 100);
      const z = zoomAtCursor(effectiveZoom, effectivePan, cursor, factor);
      patchSettings({ zoomMode: "manual", viewZoom: z.viewZoom, viewPan: z.viewPan });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };

    fit.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      fit.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [comp, effectiveZoom, effectivePan, patchSettings]);

  // §25.6 フレームステップ（←→）
  useEffect(() => {
    if (!comp) return;
    const duration = comp.duration;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setFrame(Math.max(0, frame - (e.shiftKey ? 10 : 1)));
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setFrame(Math.min(duration - 1, frame + (e.shiftKey ? 10 : 1)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [comp, frame, setFrame]);

  const [hostRect, setHostRect] = useState({ left: 0, top: 0 });

  const handlePan = useCallback(
    (pan: { x: number; y: number }) => {
      patchSettings({ zoomMode: "manual", viewPan: pan });
    },
    [patchSettings],
  );

  const handleCommitTransform = useCallback(
    (transform: Transform, label: string) => {
      if (!primaryObject) return;
      updateObject(primaryObject.id, { transform }, label);
      setDraftTransform(null);
    },
    [primaryObject, updateObject],
  );

  const fps = comp?.fps ?? 30;
  const timecode = framesToTimecode(frame, fps);
  const zoomPercent = Math.round(effectiveZoom * 100);

  const beginSpacePan = (e: React.MouseEvent) => {
    if (!spaceHeld || e.button !== 0) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const startPan = { ...effectivePan };
    const move = (ev: MouseEvent) => {
      const dx = (ev.clientX - start.x) / effectiveZoom;
      const dy = (ev.clientY - start.y) / effectiveZoom;
      patchSettings({ zoomMode: "manual", viewPan: { x: startPan.x + dx, y: startPan.y + dy } });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#1a1a1a" }}>
      {/* §20.3 composition tabs */}
      <div style={{ display: "flex", alignItems: "stretch", gap: 1, background: "#161616", borderBottom: "1px solid #333", flexShrink: 0, overflowX: "auto" }}>
        {timelineComps.map((c) => {
          const active = c.id === compId;
          return (
            <button
              key={c.id}
              onClick={() => setCurrentComp(c.id)}
              title={`${c.name} — ${c.width}×${c.height} @ ${c.fps}fps`}
              style={{
                background: active ? "#1a1a1a" : "#202020",
                border: "none",
                borderTop: active ? "2px solid #4a8acf" : "2px solid transparent",
                borderRight: "1px solid #333",
                color: active ? "#cfe6ff" : "#888",
                padding: "3px 12px",
                cursor: "pointer",
                fontSize: 11,
                whiteSpace: "nowrap",
              }}
            >
              ▦ {c.name}
            </button>
          );
        })}
      </div>

      {/* §25.1 / §25.6 toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", background: "#222", borderBottom: "1px solid #333", flexShrink: 0, flexWrap: "wrap" }}>
        <button onClick={togglePlay} style={btnStyle} title="再生/停止">{isPlaying ? "⏸" : "▶"}</button>
        <button onClick={() => setFrame(0)} style={btnStyle} title="先頭へ">⏮</button>
        <button onClick={() => setFrame(Math.max(0, frame - 1))} style={btnStyle} title="1フレーム前">◀</button>
        <button onClick={() => setFrame(Math.min((comp?.duration ?? 1) - 1, frame + 1))} style={btnStyle} title="1フレーム後">▶|</button>
        <button onClick={() => comp && setFrame(comp.duration - 1)} style={btnStyle} title="末尾へ">⏭</button>
        <button
          onClick={() => patchSettings({ loop: !viewerSettings.loop })}
          style={{ ...btnStyle, background: viewerSettings.loop ? "#2a4a2a" : "#333" }}
          title="ループ"
        >
          🔁
        </button>

        {editingFrame ? (
          <input
            autoFocus
            value={frameInput}
            onChange={(e) => setFrameInput(e.target.value)}
            onBlur={() => {
              const n = parseInt(frameInput, 10);
              if (Number.isFinite(n) && comp) setFrame(Math.max(0, Math.min(comp.duration - 1, n)));
              setEditingFrame(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditingFrame(false);
            }}
            style={{ width: 56, fontSize: 11, background: "#111", border: "1px solid #555", color: "#ccc", padding: "1px 4px" }}
          />
        ) : (
          <span
            onClick={() => { setFrameInput(String(frame)); setEditingFrame(true); }}
            style={{ fontSize: 11, color: "#7fb8f0", fontVariantNumeric: "tabular-nums", cursor: "text" }}
            title="クリックで frame 入力"
          >
            {timecode}
          </span>
        )}
        <span style={{ fontSize: 10, color: "#666" }}>F{frame}</span>

        <span style={{ color: "#444" }}>|</span>

        <button
          onClick={() => {
            const next = viewerSettings.previewQuality === "draft" ? "precise" : "draft";
            patchSettings({ previewQuality: next });
          }}
          style={{
            ...btnStyle,
            background: viewerSettings.previewQuality === "precise" ? "#2a3a4a" : "#333",
            fontSize: 10,
          }}
          title="§26.4 テキスト品質: 軽量(DOM) / 厳密(SVGアウトライン)"
        >
          {viewerSettings.previewQuality === "precise" ? "Best" : "Draft"}
        </button>

        <select
          value={viewerSettings.zoomMode === "manual" ? `manual:${viewerSettings.viewZoom}` : viewerSettings.zoomMode}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "fit" || v === "fit100") patchSettings({ zoomMode: v });
            else {
              const zoom = Number(v.split(":")[1]);
              patchSettings({ zoomMode: "manual", viewZoom: zoom });
            }
          }}
          style={{ fontSize: 10, background: "#333", color: "#ccc", border: "1px solid #555", borderRadius: 3 }}
          title="表示倍率"
        >
          {ZOOM_PRESETS.map((p) => (
            <option
              key={p.label}
              value={p.mode === "manual" ? `manual:${p.zoom}` : p.mode}
            >
              {p.label}
            </option>
          ))}
          <option value={`manual:${effectiveZoom}`}>{zoomPercent}%</option>
        </select>

        <select
          value="full"
          onChange={(e) => {
            if (e.target.value === "full") patchSettings({ resolutionProxy: "full" });
          }}
          style={{ fontSize: 10, background: "#333", color: "#ccc", border: "1px solid #555", borderRadius: 3 }}
          title="解像度プロキシ — Full のみ有効（Half/Quarter は将来実装予定）"
        >
          <option value="full">Full</option>
          <option value="half" disabled style={{ color: "#666" }}>Half (将来)</option>
          <option value="quarter" disabled style={{ color: "#666" }}>Quarter (将来)</option>
        </select>

        <OverlayToggles settings={viewerSettings} onChange={patchSettings} />

        {comp && (
          <span style={{ fontSize: 10, color: "#666", marginLeft: "auto" }}>
            <span style={{ color: "#9bd", marginRight: 6 }}>{comp.name}</span>
            {comp.width}×{comp.height} @ {comp.fps}fps
          </span>
        )}
      </div>

      {/* §25.1 canvas area */}
      <div
        ref={fitRef}
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          background: "#111",
          cursor: spaceHeld ? "grab" : "default",
        }}
        onMouseDown={beginSpacePan}
      >
        {comp ? (
          <div
            ref={stageHostRef}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: viewportSize.w || "100%",
              height: viewportSize.h || "100%",
              overflow: "hidden",
            }}
          >
            <div
              ref={stageRef}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: comp.width,
                height: comp.height,
                flexShrink: 0,
                background: comp.background ? undefined : "#000",
                boxShadow: "0 0 0 1px #444",
                transform: `scale(${effectiveZoom}) translate(${effectivePan.x}px, ${effectivePan.y}px)`,
                transformOrigin: "0 0",
                overflow: "hidden",
              }}
            >
              <div ref={containerRef} style={{ position: "absolute", top: 0, left: 0 }} />
              {project && (
                <PreviewViewerOverlay
                  comp={comp}
                  project={project}
                  frame={frame}
                  settings={viewerSettings}
                  viewZoom={effectiveZoom}
                  viewPan={effectivePan}
                  hostRect={hostRect}
                  selectedObject={primaryObject}
                  previewOverride={previewOverride}
                  draftTransform={draftTransform}
                  onDraftChange={setDraftTransform}
                  onCommit={handleCommitTransform}
                  resolveCtx={{ expressions: evaluatorRef.current }}
                  onPan={handlePan}
                  textQuality={effectiveTextQuality}
                  getFont={(family) => fontCacheRef.current.getFont(family) ?? null}
                  getImageSize={(assetId) => imageCacheRef.current.getSize(assetId)}
                />
              )}
            </div>
          </div>
        ) : (
          <div style={{ color: "#555", fontSize: 13, padding: 20 }}>No composition — create a project first</div>
        )}
      </div>
    </div>
  );
}

function OverlayToggles({
  settings,
  onChange,
}: {
  settings: PreviewViewerSettings;
  onChange: (p: Partial<PreviewViewerSettings>) => void;
}) {
  const items: { key: keyof PreviewViewerSettings; label: string }[] = [
    { key: "checkerboard", label: "⬚" },
    { key: "safeMargins", label: "Safe" },
    { key: "grid", label: "Grid" },
    { key: "centerCross", label: "＋" },
    { key: "rulers", label: "Ruler" },
  ];
  return (
    <span style={{ display: "inline-flex", gap: 2 }}>
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange({ [it.key]: !settings[it.key] })}
          style={{
            ...btnStyle,
            padding: "1px 5px",
            fontSize: 10,
            background: settings[it.key] ? "#2a3a4a" : "#333",
          }}
          title={String(it.key)}
        >
          {it.label}
        </button>
      ))}
    </span>
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
