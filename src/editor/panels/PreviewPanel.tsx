import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolve, type ExpressionEvaluator } from "../../runtime/resolve";
import { DomRenderer } from "../../runtime/DomRenderer";
import { FontOutlineCache } from "../../runtime/fontOutlineCache";
import { ImageAssetCache, registerPreviewImageCache } from "../../runtime/imageAssetCache";
import { HtmlCompPlayer } from "../../runtime/htmlComp";
import { ModuleLoader } from "../../runtime/moduleLoader";
import { IndexedDbFs } from "../../fs/IndexedDbFs";
import { getPreviewExpressionEngine } from "../expressionModuleHub";
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
import {
  loadPreviewCacheSettings,
  savePreviewCacheSettings,
  type PreviewCacheSettings,
} from "../previewCacheSettings";
import {
  type PreviewCacheDisplayStatus,
} from "../ramPreview";
import { previewCacheService } from "../previewCacheService";
import { precompRasterService } from "../precompRasterService";
import { compNeedsAutoPreviewCache } from "../previewCompAnalysis";
import { runPreviewFrameClock, runPreviewPlaybackLoop } from "../previewPlaybackLoop";
import { PreviewAudioClock } from "../previewAudioClock";
import { hasAudioLayers } from "../../player/BundleAudioClock";
import { loadAudioBuffer, peekAudioBuffer } from "../audioBufferCache";
import { loadWorkArea } from "../workAreaStorage";
import { currentTimelineComp, selectedObjects, useEditorStore } from "../store";
import { CHECKERBOARD_STYLE } from "../checkerboardStyle";
import type { HtmlComposition, SceneObject, TimelineComposition, Transform } from "../../core/schema";
import { PreviewViewerOverlay } from "./PreviewViewerOverlay";

/** §11.4 play gate: 動画 warm-up 未完了時に再生開始前へ許す最大待ち（best-effort 上限）。 */
const PLAY_GATE_TIMEOUT_MS = 500;

const _previewFs = new IndexedDbFs("mafter-effect-fs");
const _exprEngine = getPreviewExpressionEngine();
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
  const setPreviewOverride = useEditorStore((s) => s.setPreviewOverride);
  const clearPreviewOverride = useEditorStore((s) => s.clearPreviewOverride);
  const boxGizmoEnabled = useEditorStore((s) => s.boxGizmoEnabled);
  const previewQualityEditing = useEditorStore((s) => s.previewQualityEditing);
  const setPreviewQuality = useEditorStore((s) => s.setPreviewQuality);
  const projectRevision = useEditorStore((s) => s.projectRevision);
  const previewOverride = useEditorStore((s) => s.previewOverride);
  const previewCamera = useEditorStore((s) => s.previewCamera);
  const workAreaRevision = useEditorStore((s) => s.workAreaRevision);

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

  useEffect(() => {
    registerPreviewImageCache(imageCacheRef.current);
    return () => registerPreviewImageCache(null);
  }, []);
  const textQualityRef = useRef<"draft" | "precise">("draft");
  const [renderTick, setRenderTick] = useState(0);
  const frameRef = useRef(frame);
  const renderCompRef = useRef<TimelineComposition | null>(null);
  const previewOverrideRef = useRef(previewOverride);
  const previewCameraRef = useRef(previewCamera);
  const draftTransformRef = useRef<Transform | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const playbackConfigRef = useRef({
    fps: 30,
    loopStart: 0,
    loopEnd: 150,
    loop: false,
    draftPlayback: true,
  });
  const draftPlaybackRenderGenRef = useRef(0);
  const evaluatorRef = useRef<ExpressionEvaluator | undefined>(undefined);
  const cacheOverlayRef = useRef<HTMLImageElement>(null);

  const [viewerSettings, setViewerSettings] = useState<PreviewViewerSettings>(() =>
    loadViewerSettings(compId),
  );
  const [cacheSettings, setCacheSettings] = useState<PreviewCacheSettings>(() => loadPreviewCacheSettings());
  const [autoCacheSession, setAutoCacheSession] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<PreviewCacheDisplayStatus>({ kind: "idle" });
  const [useCachedFrame, setUseCachedFrame] = useState(false);
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });
  const [draftTransform, setDraftTransform] = useState<Transform | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [editingFrame, setEditingFrame] = useState(false);
  const [frameInput, setFrameInput] = useState("");

  const comp = currentTimelineComp(project, compId);
  frameRef.current = frame;
  previewOverrideRef.current = previewOverride;
  previewCameraRef.current = previewCamera;
  draftTransformRef.current = draftTransform;
  isPlayingRef.current = isPlaying;

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
  renderCompRef.current = renderComp;

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

  const patchCacheSettings = useCallback((patch: Partial<PreviewCacheSettings>) => {
    if (patch.enabled === false) {
      setAutoCacheSession(false);
      previewCacheService.getController()?.setAutoCacheSession(false);
    }
    setCacheSettings((prev) => {
      const next = { ...prev, ...patch };
      savePreviewCacheSettings(next);
      if (patch.enabled === false) {
        setUseCachedFrame(false);
        setRenderTick((t) => t + 1);
      }
      return next;
    });
  }, []);

  const effectiveCacheEnabled = cacheSettings.enabled || autoCacheSession;

  const performPreviewRender = useCallback(async (targetFrame: number, renderGen?: number) => {
    const isStale = () =>
      renderGen !== undefined && renderGen !== draftPlaybackRenderGenRef.current;

    const rc = renderCompRef.current;
    const renderer = rendererRef.current;
    if (!rc || !renderer || isStale()) return;

    const ram = previewCacheService.getController();
    // previewCamera override（プレビュー視点）が効いている間はキャッシュを使わない・残さない。
    // RAM キャッシュは出力（自動カメラ）フレームのため、override フレームを混ぜると不整合になる。
    const previewCameraOverride = previewCameraRef.current;
    const editingLive =
      previewOverrideRef.current !== null ||
      draftTransformRef.current !== null ||
      previewCameraOverride !== null;
    const preferCache = !editingLive && (ram?.shouldPreferCacheDisplay() ?? false);
    const resolveCtx = {
      expressions: evaluatorRef.current,
      previewCamera: previewCameraOverride ?? undefined,
    };

    const afterLiveRender = () => {
      if (isStale()) return;
      if (editingLive) return;
      if (isPlayingRef.current) ram?.cachePlaybackFrame(targetFrame);
      else ram?.cacheScrubbedFrame(targetFrame);
      if (!isPlayingRef.current) ram?.startBackgroundBuildIfNeeded();
    };

    if (!preferCache) {
      setUseCachedFrame(false);
      const t0 = performance.now();
      renderer.renderFrame(resolve(rc, targetFrame, resolveCtx), targetFrame);
      await renderer.flushRasterEffects();
      if (isStale()) return;
      ram?.recordLiveRenderMs(performance.now() - t0);
      afterLiveRender();
      return;
    }

    const url = await ram?.getCachedBlobUrl(targetFrame);
    if (isStale()) return;
    if (url) {
      if (cacheOverlayRef.current) cacheOverlayRef.current.src = url;
      setUseCachedFrame(true);
      if (isPlayingRef.current) ram?.notePlaybackFrame(true);
      return;
    }
    setUseCachedFrame(false);
    if (isPlayingRef.current) ram?.notePlaybackFrame(false);
    const t0 = performance.now();
    renderer.renderFrame(
      resolve(rc, targetFrame, { expressions: evaluatorRef.current }),
      targetFrame,
    );
    await renderer.flushRasterEffects();
    if (isStale()) return;
    ram?.recordLiveRenderMs(performance.now() - t0);
    afterLiveRender();
  }, []);

  const activateAutoCacheIfNeeded = useCallback(() => {
    const state = useEditorStore.getState();
    const activeComp = currentTimelineComp(state.project, state.currentCompId);
    if (!activeComp || cacheSettings.enabled || autoCacheSession) return;
    if (!compNeedsAutoPreviewCache(activeComp)) return;
    setAutoCacheSession(true);
    previewCacheService.getController()?.setAutoCacheSession(true);
    previewCacheService.updateSettings({ ...cacheSettings, enabled: true });
    previewCacheService.getController()?.startBackgroundBuildIfNeeded();
  }, [autoCacheSession, cacheSettings]);

  const handleTogglePlay = useCallback(() => {
    if (!isPlaying) activateAutoCacheIfNeeded();
    togglePlay();
  }, [activateAutoCacheIfNeeded, isPlaying, togglePlay]);

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
  const effectiveTextQuality =
    previewQualityEditing ? "draft" : viewerSettings.previewQuality;

  const workArea = useMemo(
    () => (comp ? loadWorkArea(comp.id, comp.duration) : { inPoint: 0, outPoint: 1 }),
    [comp, workAreaRevision],
  );
  const workAreaIn = workArea.inPoint;
  const workAreaOut = workArea.outPoint;

  // §28 RAM Preview（共有サービス）
  useEffect(() => {
    previewCacheService.init(_previewFs, cacheSettings);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const effective = { ...cacheSettings, enabled: effectiveCacheEnabled };
    previewCacheService.updateSettings(effective);
    previewCacheService.getController()?.setAutoCacheSession(autoCacheSession);
  }, [cacheSettings, autoCacheSession, effectiveCacheEnabled]);

  useEffect(() => {
    if (!project || !comp) {
      previewCacheService.updateConfig(null);
      return;
    }
    previewCacheService.updateConfig({
      project,
      comp,
      projectRevision,
      quality: effectiveTextQuality,
      proxy: viewerSettings.resolutionProxy,
      proxyScale,
      workArea,
    });
  }, [project, comp, projectRevision, effectiveTextQuality, viewerSettings.resolutionProxy, proxyScale, workArea]);

  // §28.11 precomp comp 単位ラスターキャッシュ — 共有 store を使うよう設定。
  useEffect(() => {
    const store = previewCacheService.getStore();
    if (!project || !store) {
      precompRasterService.configure(null);
      return;
    }
    precompRasterService.configure({
      project,
      fs: _previewFs,
      store,
      quality: effectiveTextQuality,
      proxyScale,
    });
  }, [project, effectiveTextQuality, proxyScale, effectiveCacheEnabled]);

  useEffect(() => {
    const tick = () => {
      setCacheStatus(previewCacheService.getController()?.getDisplayStatus(isPlaying) ?? { kind: "idle" });
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [isPlaying, frame, projectRevision, renderTick, effectiveCacheEnabled]);

  useEffect(() => {
    if (!isPlaying || !comp) return;
    activateAutoCacheIfNeeded();
  }, [isPlaying, comp, activateAutoCacheIfNeeded]);

  // mount/remount renderer when comp changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !comp) return;
    const r = new DomRenderer();
    r.setHtmlPlayer(_htmlPlayer);
    r.setFontCache(fontCacheRef.current);
    r.setImageCache(imageCacheRef.current);
    r.setFrameRenderCache(
      effectiveCacheEnabled ? previewCacheService.getFrameRenderCache() : null,
    );
    r.setNestedCompRasterizer(
      effectiveCacheEnabled ? precompRasterService.rasterizer : null,
    );
    r.setTextQuality(textQualityRef.current);
    r.setPreviewRenderOptions({});
    r.mount(el, comp);
    rendererRef.current = r;
    return () => {
      r.dispose();
      rendererRef.current = null;
    };
  }, [comp?.id, effectiveCacheEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    rendererRef.current?.setFrameRenderCache(
      effectiveCacheEnabled ? previewCacheService.getFrameRenderCache() : null,
    );
    rendererRef.current?.setNestedCompRasterizer(
      effectiveCacheEnabled ? precompRasterService.rasterizer : null,
    );
  }, [effectiveCacheEnabled]);

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
    // §23.3b: ネスト comp は renderNestedComp が自前で resolve() するため、各 comp の expression を
    // 評価できるよう comp 固有の evaluator を用意して DomRenderer に注入する（無いと nested 内の
    // expression が静的化し opacity/effect param も動かない）。
    const allTimelineComps = (project?.compositions ?? []).filter(
      (c): c is TimelineComposition => c.kind === "timeline",
    );
    const liveComp = (c: TimelineComposition): TimelineComposition =>
      (useEditorStore.getState().project?.compositions.find(
        (x) => x.id === c.id && x.kind === "timeline",
      ) as TimelineComposition | undefined) ?? c;
    const makeLiveEvaluator = (c: TimelineComposition) =>
      _exprEngine.makeEvaluator(c, () => liveComp(c));
    void Promise.all([
      Promise.all(allTimelineComps.map((c) => _exprEngine.prepare(c))).then(() => {
        evaluatorRef.current = makeLiveEvaluator(comp);
        rendererRef.current?.setCompEvaluators(
          new Map(allTimelineComps.map((c) => [c.id, makeLiveEvaluator(c)])),
        );
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
    // プレビュー専用: 画像を comp 解像度（長辺）まで縮小して読み込む（重い base64/再デコードを回避）。
    const proxyMaxDim = comp ? Math.max(comp.width, comp.height) : undefined;
    void Promise.all([
      fontCacheRef.current.loadFromProject(project, _previewFs),
      imageCacheRef.current.loadFromProject(project, _previewFs, { proxyMaxDim }),
    ]).then(() => setRenderTick((t) => t + 1));
  }, [project, comp?.width, comp?.height]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const editingLive = previewOverride !== null || draftTransform !== null || previewCamera !== null;
  const draftPlaybackActive = isPlaying && effectiveTextQuality === "draft" && !editingLive;

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setPreviewRenderOptions({
      holdLastRaster: isPlaying && !editingLive,
      previewVideoPlayback: isPlaying && !editingLive,
    });
  }, [isPlaying, editingLive]);

  // render on frame / project / draft transform (§28: scrub=live 初回、表示後キャッシュ・再訪問は cache 可)
  useEffect(() => {
    if (!renderComp || !rendererRef.current) return;
    if (draftPlaybackActive) return;

    const ram = previewCacheService.getController();
    const preferCache = !editingLive && (ram?.shouldPreferCacheDisplay() ?? false);

    const afterLiveRender = () => {
      if (editingLive) return;
      if (isPlaying) ram?.cachePlaybackFrame(frame);
      else ram?.cacheScrubbedFrame(frame);
      if (!isPlaying) ram?.startBackgroundBuildIfNeeded();
    };

    if (!preferCache) {
      setUseCachedFrame(false);
      const t0 = performance.now();
      rendererRef.current.renderFrame(
        resolve(renderComp, frame, {
          expressions: evaluatorRef.current,
          previewCamera: previewCamera ?? undefined,
        }),
        frame,
      );
      void rendererRef.current.flushRasterEffects().then(() => {
        ram?.recordLiveRenderMs(performance.now() - t0);
        afterLiveRender();
      });
      return;
    }

    let cancelled = false;
    void (async () => {
      const url = await ram?.getCachedBlobUrl(frame);
      if (cancelled) return;
      if (url) {
        if (cacheOverlayRef.current) cacheOverlayRef.current.src = url;
        setUseCachedFrame(true);
        if (isPlaying) ram?.notePlaybackFrame(true);
        return;
      }
      setUseCachedFrame(false);
      if (isPlaying) ram?.notePlaybackFrame(false);
      const t0 = performance.now();
      rendererRef.current!.renderFrame(
        resolve(renderComp, frame, {
          expressions: evaluatorRef.current,
          previewCamera: previewCamera ?? undefined,
        }),
        frame,
      );
      await rendererRef.current!.flushRasterEffects();
      ram?.recordLiveRenderMs(performance.now() - t0);
      afterLiveRender();
    })();

    return () => {
      cancelled = true;
    };
  }, [renderComp, frame, renderTick, projectRevision, isPlaying, previewOverride, previewCamera, draftTransform, effectiveCacheEnabled, draftPlaybackActive, editingLive]);

  playbackConfigRef.current = {
    fps: comp?.fps ?? 30,
    loopStart: workAreaIn,
    loopEnd: workAreaOut,
    loop: viewerSettings.loop,
    draftPlayback: draftPlaybackActive,
  };

  // §25.6 / §28 / §27.12 / §11.5 再生ループ。
  // 音声レイヤーがあれば AudioContext をマスタークロックにして音と frame を同期させる（無ければ従来 rAF）。
  // Draft=直接 render、Best=frame clock + React effect。
  useEffect(() => {
    if (!isPlaying || !comp) return;

    const cfg = playbackConfigRef.current;
    const renderFrame = cfg.draftPlayback
      ? (f: number) => {
          const gen = ++draftPlaybackRenderGenRef.current;
          return performPreviewRender(f, gen);
        }
      : undefined;

    const startRafClock = () => {
      if (cfg.draftPlayback) {
        return runPreviewPlaybackLoop({
          fps: cfg.fps,
          loopStart: cfg.loopStart,
          loopEnd: cfg.loopEnd,
          loop: cfg.loop,
          initialFrame: frameRef.current,
          onFrameChange: (f) => setFrame(f),
          onPlaybackEnd: () => setPlaying(false),
          renderFrame: (f) => {
            const gen = ++draftPlaybackRenderGenRef.current;
            return performPreviewRender(f, gen);
          },
        });
      }
      return runPreviewFrameClock({
        fps: cfg.fps,
        loopStart: cfg.loopStart,
        loopEnd: cfg.loopEnd,
        loop: cfg.loop,
        initialFrame: frameRef.current,
        onFrameChange: (f) => setFrame(f),
        onPlaybackEnd: () => setPlaying(false),
      });
    };

    let cancelled = false;
    let stop: (() => void) | null = null;

    const startClock = (): void => {
      if (cancelled) return;
      if (!project || !hasAudioLayers(project, comp)) {
        stop = startRafClock();
        return;
      }
      // 音声あり: AudioContext マスタークロック。decode は非同期なので、成功するまで stop ハンドルを保持。
      let fallbackStop: (() => void) | null = null;
      const clock = new PreviewAudioClock(project, comp, _previewFs, {
        fps: cfg.fps,
        loopStart: cfg.loopStart,
        loopEnd: cfg.loopEnd,
        loop: cfg.loop,
        initialFrame: frameRef.current,
        onFrameChange: (f) => setFrame(f),
        onPlaybackEnd: () => setPlaying(false),
        renderFrame,
      });
      void clock.start().then((ok) => {
        if (cancelled) { clock.stop(); return; }
        if (!ok) fallbackStop = startRafClock(); // decode 全失敗 → 無音 rAF
      });
      stop = () => {
        clock.stop();
        fallbackStop?.();
      };
    };

    // §11.4 条件付き play gate: warm-up 済みなら遅延ゼロで即開始。未完了の動画があるときだけ
    // 短時間（PLAY_GATE_TIMEOUT_MS 上限）prime を待ってから再生開始＝開幕の「動画だけ遅れて登場」を防ぐ。
    const renderer = rendererRef.current;
    if (renderer && !renderer.areMountedVideosPrimed(cfg.fps)) {
      void renderer
        .primeMountedVideos(cfg.fps, PLAY_GATE_TIMEOUT_MS)
        .catch(() => {}) // best-effort: 失敗しても再生は始める
        .then(startClock);
    } else {
      startClock();
    }

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [isPlaying, comp?.id, draftPlaybackActive, setFrame, setPlaying, performPreviewRender, project]);

  // §11.5: 編集中 comp に音声レイヤーがあれば decode 済みバッファをメモリ常駐させ、
  // 再生ボタンを押した瞬間に decode 待ちなく発音できるようにする（プリロード）。
  useEffect(() => {
    if (!project || !comp) return;
    for (const obj of comp.objects) {
      if (!obj.enabled) continue;
      const cmp = obj.components.find((c) => c.type === "audio");
      const assetId = cmp?.props["asset"];
      if (typeof assetId !== "string" || peekAudioBuffer(assetId)) continue;
      const asset = project.assets.find((a) => a.id === assetId);
      if (!asset) continue;
      void loadAudioBuffer(assetId, () => _previewFs.read(asset.path)).catch(() => { /* 失敗は再生時に再試行 */ });
    }
  }, [project, comp?.id, comp?.objects]);

  // §11.4: 編集中 comp に動画レイヤーがあれば、idle 中に <video> を現フレームへ seek + decode
  // まで warm-up しておく（音声プリロード §11.5 と対）。Play 直後の「動画だけ遅れて登場」を防ぐ。
  // 対象は編集中 comp の enabled video のみ（プロジェクト全体は対象外）。export 経路は不変（INV-2）。
  useEffect(() => {
    if (!project || !comp || isPlaying) return;
    const hasVideo = comp.objects.some(
      (o) => o.enabled && o.components.some((c) => c.type === "video"),
    );
    if (!hasVideo) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const fps = comp.fps;
    const run = (): void => {
      void renderer.primeMountedVideos(fps).catch(() => { /* 失敗は再生時に再試行 */ });
    };
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void) => number })
      .requestIdleCallback;
    if (ric) {
      const handle = ric(run);
      const cancel = (window as Window & { cancelIdleCallback?: (h: number) => void })
        .cancelIdleCallback;
      return () => cancel?.(handle);
    }
    const handle = window.setTimeout(run, 200);
    return () => window.clearTimeout(handle);
  }, [project, comp?.id, comp?.objects, renderTick, frame, isPlaying]);

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

  // §5.6 comp 背景色をライブ反映（mount 後の編集で DomRenderer root を更新）。
  // 未設定（透明）は root 背景をクリアし、背後の stage（チェッカー/黒）を見せる。
  useEffect(() => {
    const root = rendererRef.current?.getRoot();
    if (!root) return;
    const c = comp?.background;
    root.style.background = c
      ? `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`
      : "";
  }, [comp?.background, comp?.id, renderTick]);

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

  // §26.3.3 ボックスリサイズ: ライブは previewOverride、確定は updateObject。
  const handleComponentPreview = useCallback(
    (patch: Partial<SceneObject>) => {
      if (!primaryObject) return;
      setPreviewOverride({ objectId: primaryObject.id, patch });
    },
    [primaryObject, setPreviewOverride],
  );
  const handleComponentCommit = useCallback(
    (patch: Partial<SceneObject>, label: string) => {
      if (!primaryObject) return;
      updateObject(primaryObject.id, patch, label);
      clearPreviewOverride();
    },
    [primaryObject, updateObject, clearPreviewOverride],
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
        <button onClick={handleTogglePlay} style={btnStyle} title="再生/停止">{isPlaying ? "⏸" : "▶"}</button>
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

        <CacheStatusBadge status={cacheStatus} autoCache={autoCacheSession} />

        <label
          style={{ fontSize: 10, color: effectiveCacheEnabled ? "#aaa" : "#666", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}
          title="OFF: 常に live 描画（HTML/bundle 向け）。RAM/disk への書き込みなし"
        >
          <input
            type="checkbox"
            checked={effectiveCacheEnabled}
            onChange={(e) => patchCacheSettings({ enabled: e.target.checked })}
          />
          Caching
        </label>
        {effectiveCacheEnabled && (
          <>
            <button
              onClick={() => void previewCacheService.clearAll()}
              style={{ ...btnStyle, fontSize: 10 }}
              title="プレビューキャッシュを全削除"
            >
              Clear
            </button>
            <label style={{ fontSize: 10, color: "#888", display: "inline-flex", alignItems: "center", gap: 4 }}>
              RAM
              <input
                type="number"
                min={64}
                max={4096}
                value={cacheSettings.maxRamMB}
                onChange={(e) => {
                  const maxRamMB = Math.max(64, Math.min(4096, Number(e.target.value) || 256));
                  patchCacheSettings({ maxRamMB });
                }}
                style={{ width: 48, fontSize: 10, background: "#222", color: "#ccc", border: "1px solid #555" }}
              />
              MB
            </label>
          </>
        )}

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
                ...(comp.background
                  ? null
                  : viewerSettings.checkerboard
                    ? CHECKERBOARD_STYLE
                    : { background: "#000" }),
                boxShadow: "0 0 0 1px #444",
                transform: `scale(${effectiveZoom}) translate(${effectivePan.x}px, ${effectivePan.y}px)`,
                transformOrigin: "0 0",
                overflow: "hidden",
              }}
            >
              <div
                ref={containerRef}
                data-testid="preview-canvas-root"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  visibility: useCachedFrame ? "hidden" : "visible",
                }}
              />
              <img
                ref={cacheOverlayRef}
                alt=""
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  display: useCachedFrame ? "block" : "none",
                  pointerEvents: "none",
                }}
              />
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
                  onComponentPreview={handleComponentPreview}
                  onComponentCommit={handleComponentCommit}
                  boxGizmoEnabled={boxGizmoEnabled}
                  resolveCtx={{ expressions: evaluatorRef.current, previewCamera: previewCamera ?? undefined }}
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

function CacheStatusBadge({ status, autoCache }: { status: PreviewCacheDisplayStatus; autoCache?: boolean }) {
  if (status.kind === "off") {
    return <span style={{ fontSize: 10, color: "#666" }}>○ Cache OFF</span>;
  }
  if (autoCache) {
    return <span style={{ fontSize: 10, color: "#8af" }}>⚡ Auto Cache</span>;
  }
  if (status.kind === "realtime") {
    return <span style={{ fontSize: 10, color: "#6c6" }}>● Realtime</span>;
  }
  if (status.kind === "building") {
    return (
      <span style={{ fontSize: 10, color: "#cc6" }}>
        ◐ Caching {Math.round(status.progress * 100)}%
      </span>
    );
  }
  if (status.kind === "cached") {
    return <span style={{ fontSize: 10, color: "#6af" }}>▶ Cached</span>;
  }
  return null;
}
