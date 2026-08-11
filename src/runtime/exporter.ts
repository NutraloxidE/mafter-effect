// §11.2 Export — browser best-effort
// 決定論 frame ステップ → DOM→raster (SVG foreignObject) → WebCodecs encode / PNG seq
// Audio: OfflineAudioContext mix → AudioEncoder → mux

import JSZip from "jszip";
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from "mp4-muxer";
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from "webm-muxer";
import { compositionDir } from "../core/paths";
import { SwarmFrameMismatchError } from "../swarm/core/frameVerification";
import { buildRemoteFrameProducers, spotCheckFrames } from "../swarm/core/remoteFrameProducer";
import type { SwarmRenderJob, SwarmRenderResult } from "../swarm/core/types";
import type { ExportConfig, HtmlComposition, Project, TimelineComposition } from "../core/schema";
import type { FileSystem } from "../fs/FileSystem";
import { DomRenderer } from "./DomRenderer";
import { FontOutlineCache } from "./fontOutlineCache";
import { ImageAssetCache } from "./imageAssetCache";
import { ExpressionEngine } from "./expressionEngine";
import { HtmlCompPlayer } from "./htmlComp";
import { ModuleLoader } from "./moduleLoader";
import { resolve, type ExpressionEvaluator } from "./resolve";
import { compositeExportFrame, type ExportCompositeOptions } from "./exportComposite";
import { collectFootageAudioSources, scheduleGainAutomation } from "./footageAudio";
import { collectFadeClips, computeFadeSuppression, fadeSec, isAutoFadeEnabled, scheduleDeclickRamps } from "./footageAutoFade";
import { resolveFootageAudioPath } from "./footagePlayback";
import { resolveExportVideoEncode } from "./exportVideoEncode";
import { waitForEncoderQueueAtMost } from "./encoderBackpressure";
import { isGpuDirectSurfaceEnabled } from "./compositor/gpuCompositorFlag";
import { isStaticLayerCaptureCacheEnabled } from "./staticLayerCaptureCache";
import { isDirectVideoCaptureEnabled } from "./directVideoCapture";
import { isDirectSolidCaptureEnabled } from "./directSolidCapture";
import { isDirectImageCaptureEnabled } from "./directImageCapture";
import { createWorkerVideoExportSession, isWorkerVideoExportEnabled } from "./workerVideoExport";
import {
  compTreeHasVideo,
  isMultiRenderContextEnabled,
  multiRenderContextCount,
  runOrderedMultiContext,
} from "./multiRenderContext";

export type ExportPhase = "prepare" | "render" | "encode" | "audio" | "bake" | "pack" | "done" | "error";

export interface ExportProgress {
  phase: ExportPhase;
  frame: number;
  totalFrames: number;
  message: string;
}

export type ProgressCallback = (p: ExportProgress) => void;

/** 実際に生成された出力形式（動画 encode 失敗で PNG-seq に落ちた場合 format が変わる）。 */
export interface ExportResult {
  blob: Blob;
  format: ExportConfig["format"];
  /** 要求した format と異なる結果になった場合の理由（PNG-seq フォールバック時のみ）。 */
  fallbackReason?: string;
}

/**
 * WebCodecs(`VideoEncoder`) が使えない理由を判定する。使える場合は null。
 * secure context（https または localhost）でない場合や非対応ブラウザでは undefined になり、
 * mp4/webm は必ず PNG-seq へフォールバックする。原因をユーザーに提示できるようにする。
 */
export function diagnoseVideoSupport(): string | null {
  if (typeof VideoEncoder !== "undefined") return null;
  const secure = typeof isSecureContext === "undefined" ? true : isSecureContext;
  if (!secure) {
    return "このページが secure context ではないため WebCodecs を利用できません。"
      + "http://localhost / 127.0.0.1 または https:// で開いてください（LAN の IP アドレス経由では無効）。";
  }
  return "このブラウザは WebCodecs (VideoEncoder) に対応していません。Chrome / Edge 94 以降で開いてください。";
}

interface VideoEncodeStats {
  chunkCount: number;
  hasDecoderConfig: boolean;
  error: Error | null;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * §11.2 — 指定 comp をオフスクリーン DOM でフレームステップしてエクスポートする。
 * Preview と同じ resolve → DomRenderer パイプラインを使い INV-2 を保証する。
 */
/**
 * Optional swarm hooks. Kept out of ExportConfig (a §5 type) because this is transport wiring,
 * not export settings, and an export must behave identically when it is absent.
 */
export interface ExportSwarmHooks {
  workerCount: number;
  submit: (job: SwarmRenderJob, timeoutMs: number) => Promise<SwarmRenderResult | null>;
  /** Ships footage before the first frame is leased, so no job pays for the transfer. */
  preload?: (project: Project, comp: TimelineComposition) => Promise<void>;
  timeoutMs?: number;
}

export async function exportComposition(
  project: Project,
  compId: string,
  fs: FileSystem,
  config: ExportConfig,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
  swarm?: ExportSwarmHooks,
): Promise<ExportResult> {
  const comp = project.compositions.find((c) => c.id === compId);
  if (!comp || comp.kind !== "timeline") {
    throw new Error("Timeline composition not found: " + compId);
  }
  const tlComp = comp as TimelineComposition;
  const htmlComps = project.compositions.filter(
    (c): c is HtmlComposition => c.kind === "html",
  );
  const timelineComps = project.compositions.filter(
    (c): c is TimelineComposition => c.kind === "timeline" && c.id !== compId,
  );

  const [startFrame, endFrame] = config.range;
  const totalFrames = Math.max(1, endFrame - startFrame);
  const nw = tlComp.width;
  const nh = tlComp.height;
  // H.264 / VP9 は偶数解像度が必須。Math.round 後の奇数 width/height で encode が silently fail し
  // 再生不能なコンテナだけが出力されることがある。
  const w = evenDim(nw * config.scale);
  const h = evenDim(nh * config.scale);

  // オフスクリーンコンテナを画面外に配置（レイアウト影響なし）
  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:-${nw + 20}px;top:0;width:${nw}px;height:${nh}px;overflow:hidden;z-index:-99999;pointer-events:none;`;
  document.body.appendChild(container);

  // §11.2 Phase 6（実験・既定 OFF）: 複数レンダリング context を使うときの追加 renderer / container。
  const extraRenderers: DomRenderer[] = [];
  const extraContainers: HTMLElement[] = [];

  try {
    const loader = new ModuleLoader(fs);
    const engine = new ExpressionEngine(loader);
    const htmlLoader = new ModuleLoader(fs);
    const player = new HtmlCompPlayer(htmlLoader);
    const renderer = new DomRenderer();
    renderer.setHtmlPlayer(player);
    // §27.4 / INV-2 — captureElementToCanvas（foreignObject）は backdrop-filter 非対応のため、
    // Live 調整は exportComposite.ts のオフDOM・ステートレス z 順コンポジタで背面 master に焼く。
    // exportCompositeMode 中、DomRenderer は調整レイヤーの live DOM を破壊せず effect chain を
    // entry.exportChain に保存するだけ（旧 forceAdjustmentRaster bake のちらつきを根絶）。
    renderer.setPreviewRenderOptions({ exportCompositeMode: true, exportVideoStep: true });
    const fontCache = new FontOutlineCache();
    const imageCache = new ImageAssetCache();
    await Promise.all([
      fontCache.loadFromProject(project, fs),
      imageCache.loadFromProject(project, fs),
    ]);
    renderer.setFontCache(fontCache);
    renderer.setImageCache(imageCache);
    renderer.setTextQuality(config.textRenderMode ?? "precise");
    renderer.mount(container, tlComp);
    renderer.setHtmlComps(new Map(htmlComps.map((c) => [c.id, c])));
    renderer.setTimelineComps(new Map(timelineComps.map((c) => [c.id, c])));

    onProgress({ phase: "prepare", frame: 0, totalFrames, message: "Loading expressions & HTML comps…" });

    let evaluator: ExpressionEvaluator | undefined;
    let compEvaluators = new Map<string, ExpressionEvaluator>();
    await Promise.all([
      engine.prepare(tlComp).then(() => { evaluator = engine.makeEvaluator(tlComp); }),
      // §23.3b: ネスト comp の expression も export で評価する（preview と一致・INV-2）。
      Promise.all(timelineComps.map((c) => engine.prepare(c))).then(() => {
        compEvaluators = new Map(timelineComps.map((c) => [c.id, engine.makeEvaluator(c)]));
        renderer.setCompEvaluators(compEvaluators);
      }),
      player.prepare(htmlComps, (id) => `${compositionDir(id)}/script.js`),
    ]);

    checkAbort(signal);

    // §11.2 Phase 6（実験・既定 OFF）— 複数レンダリング context を構築する。
    //  除外: comp（ネスト先含む）に video component を含む（decoder 重複回避）、video 形式で worker
    //  export と併用（別実験・排他）。イミュータブルな font/image cache と純関数 evaluator は共有し、
    //  mutable な DOM / renderer / HTML player は context ごとに分離する。
    const multiContextEligible = isMultiRenderContextEnabled()
      && !compTreeHasVideo(project, tlComp)
      && !(config.format !== "png-seq" && isWorkerVideoExportEnabled());
    if (multiContextEligible) {
      const wantContexts = multiRenderContextCount();
      for (let i = 1; i < wantContexts; i++) {
        checkAbort(signal);
        const c2 = document.createElement("div");
        c2.style.cssText = `position:fixed;left:-${(nw + 20) * (i + 1)}px;top:0;width:${nw}px;height:${nh}px;overflow:hidden;z-index:-99999;pointer-events:none;`;
        document.body.appendChild(c2);
        extraContainers.push(c2);
        const player2 = new HtmlCompPlayer(new ModuleLoader(fs));
        const renderer2 = new DomRenderer();
        renderer2.setHtmlPlayer(player2);
        renderer2.setPreviewRenderOptions({ exportCompositeMode: true, exportVideoStep: true });
        renderer2.setFontCache(fontCache);
        renderer2.setImageCache(imageCache);
        renderer2.setTextQuality(config.textRenderMode ?? "precise");
        renderer2.mount(c2, tlComp);
        renderer2.setHtmlComps(new Map(htmlComps.map((c) => [c.id, c])));
        renderer2.setTimelineComps(new Map(timelineComps.map((c) => [c.id, c])));
        renderer2.setCompEvaluators(compEvaluators);
        await player2.prepare(htmlComps, (id) => `${compositionDir(id)}/script.js`);
        extraRenderers.push(renderer2);
      }
    }

    if (config.format === "png-seq") {
      const blob = await runPngSeq(
        tlComp, renderer, evaluator, config,
        startFrame, totalFrames, nw, nh, w, h, extraRenderers, onProgress, signal,
        { project, compId, endFrame, swarm },
      );
      return { blob, format: "png-seq" };
    } else {
      // Source metadata is synchronous; the opt-in path may overlap decode/mix with deterministic video rendering.
      let audioTask = createAudioMixTask(project, tlComp, startFrame, endFrame, config.fps, fs);
      if (!isAudioMixOverlapEnabled() && audioTask.hasAudioSources) {
        const audioMix = await audioTask.promise;
        audioTask = { hasAudioSources: audioMix !== null, promise: Promise.resolve(audioMix) };
      }
      try {
        const blob = await runVideo(
          tlComp, renderer, evaluator, config,
          startFrame, totalFrames, nw, nh, w, h, extraRenderers, audioTask, onProgress, signal,
        );
        return { blob, format: config.format };
      } catch (e) {
        checkAbort(signal);
        // VideoEncoder 自体が無い場合は環境要因を具体的に説明する。それ以外は実エラーを伝える。
        const reason = diagnoseVideoSupport() ?? (e instanceof Error ? e.message : String(e));
        onProgress({
          phase: "render",
          frame: 0,
          totalFrames,
          message: `Video encode failed (${reason}), falling back to PNG sequence`,
        });
        const blob = await runPngSeq(
          tlComp, renderer, evaluator, { ...config, format: "png-seq" },
          startFrame, totalFrames, nw, nh, w, h, extraRenderers, onProgress, signal,
          { project, compId, endFrame, swarm },
        );
        return { blob, format: "png-seq", fallbackReason: reason };
      }
    }
  } finally {
    container.remove();
    for (const r of extraRenderers) {
      try { r.dispose(); } catch { /* best-effort cleanup */ }
    }
    for (const c of extraContainers) c.remove();
  }
}

// §11.2 Phase 6 — 1 context の1フレーム描画（resolve → render → flush → composite）。
async function renderContextFrameCanvas(
  renderer: DomRenderer,
  comp: TimelineComposition,
  evaluator: ExpressionEvaluator | undefined,
  frame: number,
  nw: number, nh: number, w: number, h: number, bg: string,
  options: ExportCompositeOptions,
): Promise<HTMLCanvasElement> {
  renderer.renderFrame(resolve(comp, frame, { expressions: evaluator }), frame);
  // レイヤ直付け raster の完了のみ待つ。調整合成は compositeExportFrame が行う。
  await renderer.flushRasterEffects();
  await renderer.flushVideoFrames();
  await nextTick();
  return compositeExportFrame(renderer, nw, nh, w, h, bg, options);
}

/** multi-context 経路の frame 描画数を bench 用に記録する。 */
function recordMultiContextFrames(totalFrames: number, contextFrameCounts: number[]): void {
  const g = globalThis as {
    __mafterMultiRenderContextFrames?: number;
    __mafterMultiRenderContextDist?: number[];
  };
  g.__mafterMultiRenderContextFrames = (g.__mafterMultiRenderContextFrames ?? 0) + totalFrames;
  g.__mafterMultiRenderContextDist = contextFrameCounts;
}

// ─── Frame capture ────────────────────────────────────────────────────────────

// §5.4d / §27.4 capture — フレーム合成は exportComposite.ts の compositeExportFrame に一本化。
// 調整レイヤー・CSS blend が無ければ単一ショット root capture（3D 深度保持）、あれば z 順に
// 累積 master を組み調整レイヤーで背面に effect を焼く（オフDOM・ステートレス・INV-2）。
// flattenShadow / svgToDataUrl は rasterCapture.ts に移動済み。

// ─── PNG sequence ─────────────────────────────────────────────────────────────

async function runPngSeq(
  comp: TimelineComposition,
  renderer: DomRenderer,
  evaluator: ExpressionEvaluator | undefined,
  config: ExportConfig,
  startFrame: number,
  totalFrames: number,
  nw: number, nh: number, w: number, h: number,
  extraRenderers: DomRenderer[],
  onProgress: ProgressCallback,
  signal?: AbortSignal,
  remote?: { project: Project; compId: string; endFrame: number; swarm?: ExportSwarmHooks },
): Promise<Blob> {
  const zip = new JSZip();
  const bg = config.alpha ? "transparent" : (comp.background ? rgbaToHex(comp.background) : "#000000");
  // PNG 連番は元々オプション無し（純 Canvas2D）で合成する。multi-context も同じ経路を使う。
  const addFrame = async (fi: number, canvas: HTMLCanvasElement): Promise<void> => {
    const pngBlob = await canvasToBlob(canvas, "image/png");
    zip.file(`frame_${String(fi).padStart(6, "0")}.png`, pngBlob);
  };
  // Encoding at production time lets the reorder buffer hold ~350KB PNGs instead of ~2MB
  // canvases, which is what makes a window large enough to keep a slow producer off the
  // critical path affordable.
  const encodeFrame = (canvas: HTMLCanvasElement): Promise<Blob> => canvasToBlob(canvas, "image/png");
  const storeFrame = async (fi: number, pngBlob: Blob): Promise<void> => {
    zip.file(`frame_${String(fi).padStart(6, "0")}.png`, pngBlob);
  };

  // ローカル描画は context を共有するので直列化する。remote producer のフォールバックもここを通る。
  let localChain: Promise<unknown> = Promise.resolve();
  const renderLocallySerialized = (frame: number): Promise<HTMLCanvasElement> => {
    const run = localChain.then(() =>
      renderContextFrameCanvas(renderer, comp, evaluator, frame, nw, nh, w, h, bg, {}));
    localChain = run.catch(() => undefined);
    return run;
  };
  const remoteProducers = remote?.swarm ? buildRemoteFrameProducers({
    swarm: remote.swarm,
    project: remote.project,
    comp,
    renderRevision: `export-${remote.compId}-${startFrame}-${remote.endFrame}-${w}x${h}`,
    profile: { quality: config.textRenderMode === "draft" ? "draft" : "precise", proxy: "full", width: w, height: h },
    renderLocally: renderLocallySerialized,
    verifyFrames: new Set(spotCheckFrames(totalFrames).map((fi) => startFrame + fi)),
  }) : [];

  if (remote?.swarm?.preload && remoteProducers.length > 0) {
    onProgress({ phase: "prepare", frame: 0, totalFrames, message: "Sending footage to workers…" });
    await remote.swarm.preload(remote.project, comp);
  }

  const renderSerially = async (): Promise<void> => {
    for (let fi = 0; fi < totalFrames; fi++) {
      checkAbort(signal);
      const canvas = await renderLocallySerialized(startFrame + fi);
      onProgress({ phase: "render", frame: fi, totalFrames, message: `Frame ${fi + 1}/${totalFrames}` });
      await addFrame(fi, canvas);
    }
  };

  if (extraRenderers.length > 0 || remoteProducers.length > 0) {
    // §11.2 Phase 6 — 複数 context で並行描画し、frame 昇順で zip に整列格納する。
    const contexts = [renderer, ...extraRenderers];
    let rendered = 0;
    const multiOptions = {
      producers: [
        ...contexts.map((r) => (frame: number) =>
          r === renderer
            ? renderLocallySerialized(frame)
            : renderContextFrameCanvas(r, comp, evaluator, frame, nw, nh, w, h, bg, {})),
        ...remoteProducers,
      ],
      totalFrames,
      startFrame,
      // Local contexts run at the same speed, so a window of 2*N is enough for them. A worker is
      // slower per frame (render + transfer), and with the default window the fast local producer
      // blocks a few frames after the remote one, leaving the host idle for most of the export.
      // Frames are buffered as PNG, so the window can span the export: a worker may work far
      // ahead of what has been written without ever gating it.
      maxReorderAhead: remoteProducers.length > 0 ? totalFrames : undefined,
      // Remote producers take work from the end of the range so their latency never sits in
      // front of the next frame to write.
      pullFromTail: [
        ...contexts.map(() => false),
        ...remoteProducers.map(() => true),
      ],
      prepare: encodeFrame,
      onRendered: () => {
        rendered++;
        onProgress({ phase: "render", frame: rendered - 1, totalFrames, message: `Frame ${rendered}/${totalFrames}` });
      },
      onFrame: storeFrame,
      checkAbort: () => checkAbort(signal),
    };
    try {
      const res = await runOrderedMultiContext(multiOptions);
      recordMultiContextFrames(totalFrames, res.contextFrameCounts);
    } catch (error) {
      if (!(error instanceof SwarmFrameMismatchError)) throw error;
      // A worker produced pixels this device disagrees with. Discard everything it contributed
      // and render the whole sequence locally rather than shipping a file we cannot vouch for.
      onProgress({
        phase: "render",
        frame: 0,
        totalFrames,
        message: `Worker output rejected (${error.message}); rendering locally`,
      });
      zip.remove("");
      for (const name of Object.keys(zip.files)) zip.remove(name);
      await renderSerially();
    }
  } else {
    await renderSerially();
  }

  onProgress({ phase: "encode", frame: totalFrames, totalFrames, message: "Packaging ZIP…" });
  const result = await zip.generateAsync({ type: "blob" });
  onProgress({ phase: "done", frame: totalFrames, totalFrames, message: "Done" });
  return result;
}

// ─── WebCodecs video (mp4 / webm) ────────────────────────────────────────────

async function runVideo(
  comp: TimelineComposition,
  renderer: DomRenderer,
  evaluator: ExpressionEvaluator | undefined,
  config: ExportConfig,
  startFrame: number,
  totalFrames: number,
  nw: number, nh: number, w: number, h: number,
  extraRenderers: DomRenderer[],
  audioTask: AudioMixTask,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<Blob> {
  if (typeof VideoEncoder === "undefined") {
    throw new Error("WebCodecs unavailable");
  }

  const fps = config.fps;
  // alpha export（webm VP9）では透明背景にする。PNG-seq の runPngSeq と同じ方針。
  // mp4(H.264) は alpha 非対応で UI も alpha を出さないため config.alpha は常に false。
  const bg = config.alpha ? "transparent" : (comp.background ? rgbaToHex(comp.background) : "#000000");
  const hasAudio = audioTask.hasAudioSources;

  // ─ muxer セットアップ ─
  type ChunkAccum = { chunk: EncodedVideoChunk; meta: EncodedVideoChunkMetadata | undefined }[];
  const videoChunks: ChunkAccum = [];

  if (config.format === "mp4") {
    return await runMp4(
      comp, renderer, evaluator, config, startFrame, totalFrames,
      nw, nh, w, h, fps, bg, hasAudio, audioTask.promise, videoChunks, extraRenderers, onProgress, signal,
    );
  } else {
    return await runWebm(
      comp, renderer, evaluator, config, startFrame, totalFrames,
      nw, nh, w, h, fps, bg, hasAudio, audioTask.promise, videoChunks, extraRenderers, onProgress, signal,
    );
  }
}

async function runMp4(
  comp: TimelineComposition,
  renderer: DomRenderer,
  evaluator: ExpressionEvaluator | undefined,
  config: ExportConfig,
  startFrame: number,
  totalFrames: number,
  nw: number, nh: number, w: number, h: number,
  fps: number,
  bg: string,
  hasAudio: boolean,
  audioMixPromise: Promise<AudioMixResult | null>,
  _videoChunks: unknown[],
  extraRenderers: DomRenderer[],
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!hasAudio && isWorkerVideoExportEnabled()) {
    const workerEncode = resolveExportVideoEncode(config);
    return await runWorkerVideo(
      "mp4", comp, renderer, evaluator, startFrame, totalFrames, nw, nh, w, h, fps, bg, false,
      {
        codec: avcCodecString(w, h, fps), width: w, height: h,
        bitrate: workerEncode.bitrate, framerate: fps,
        ...(workerEncode.latencyMode ? { latencyMode: workerEncode.latencyMode } : {}),
      },
      onProgress, signal,
    );
  }
  const target = new Mp4Target();
  const muxer = new Mp4Muxer({
    target,
    video: { codec: "avc", width: w, height: h, frameRate: fps },
    ...(hasAudio ? {
      audio: { codec: "aac", numberOfChannels: 2, sampleRate: 48000 },
    } : {}),
    fastStart: resolveMp4FastStart(totalFrames, hasAudio, totalFrames / fps),
    firstTimestampBehavior: "offset",
  });

  const videoEncoder = createVideoEncoder((chunk, meta) => {
    muxer.addVideoChunk(chunk, meta);
  });
  const encode = resolveExportVideoEncode(config);
  try {
    await configureVideoEncoder(videoEncoder.encoder, {
      // AVC level は解像度に合わせて選ぶ。固定 3.1 だと 1080p で coded-area 超過エラーになる。
      codec: avcCodecString(w, h, fps),
      width: w,
      height: h,
      bitrate: encode.bitrate,
      framerate: fps,
      ...(encode.latencyMode ? { latencyMode: encode.latencyMode } : {}),
    });

    await encodeVideoFrames(
      comp, renderer, evaluator, startFrame, totalFrames, nw, nh, w, h, fps, bg,
      videoEncoder, !config.alpha, !config.alpha && isGpuDirectSurfaceEnabled(), extraRenderers, onProgress, signal,
    );
    await videoEncoder.encoder.flush();
    if (videoEncoder.stats.error) throw videoEncoder.stats.error;

    const audioMix = await audioMixPromise;
    if (audioMix) {
      onProgress({ phase: "audio", frame: totalFrames, totalFrames, message: "Encoding audio…" });
      try {
        await encodeAudioToMuxer(audioMix, (chunk, meta) => muxer.addAudioChunk(chunk, meta ?? undefined), "mp4a.40.2", config.audioBitrate, signal);
      } catch {
        // 音声 encode 失敗時も映像だけは書き出す（PNG-seq フォールバックは避ける）
      }
    }

    onProgress({ phase: "pack", frame: totalFrames, totalFrames, message: "Finalizing MP4…" });
    muxer.finalize();
    onProgress({ phase: "done", frame: totalFrames, totalFrames, message: "Done" });
    return new Blob([target.buffer], { type: "video/mp4" });
  } finally {
    safeCloseEncoder(videoEncoder.encoder);
  }
}

async function runWebm(
  comp: TimelineComposition,
  renderer: DomRenderer,
  evaluator: ExpressionEvaluator | undefined,
  config: ExportConfig,
  startFrame: number,
  totalFrames: number,
  nw: number, nh: number, w: number, h: number,
  fps: number,
  bg: string,
  hasAudio: boolean,
  audioMixPromise: Promise<AudioMixResult | null>,
  _videoChunks: unknown[],
  extraRenderers: DomRenderer[],
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!hasAudio && !config.alpha && isWorkerVideoExportEnabled()) {
    const workerEncode = resolveExportVideoEncode(config);
    return await runWorkerVideo(
      "webm", comp, renderer, evaluator, startFrame, totalFrames, nw, nh, w, h, fps, bg, false,
      {
        codec: "vp09.00.10.08", width: w, height: h,
        bitrate: workerEncode.bitrate, framerate: fps, alpha: "discard",
        ...(workerEncode.latencyMode ? { latencyMode: workerEncode.latencyMode } : {}),
      },
      onProgress, signal,
    );
  }
  const target = new WebmTarget();
  const muxer = new WebmMuxer({
    target,
    video: { codec: "V_VP9", width: w, height: h, frameRate: fps, alpha: config.alpha },
    ...(hasAudio ? {
      audio: { codec: "A_OPUS", numberOfChannels: 2, sampleRate: 48000 },
    } : {}),
  });

  const videoEncoder = createVideoEncoder((chunk, meta) => {
    muxer.addVideoChunk(chunk, meta);
  });
  const encode = resolveExportVideoEncode(config);
  try {
    await configureVideoEncoder(videoEncoder.encoder, {
      codec: "vp09.00.10.08",
      width: w,
      height: h,
      bitrate: encode.bitrate,
      framerate: fps,
      alpha: config.alpha ? "keep" : "discard",
      ...(encode.latencyMode ? { latencyMode: encode.latencyMode } : {}),
    });

    await encodeVideoFrames(
      comp, renderer, evaluator, startFrame, totalFrames, nw, nh, w, h, fps, bg,
      videoEncoder, !config.alpha, !config.alpha && isGpuDirectSurfaceEnabled(), extraRenderers, onProgress, signal,
    );
    await videoEncoder.encoder.flush();
    if (videoEncoder.stats.error) throw videoEncoder.stats.error;

    const audioMix = await audioMixPromise;
    if (audioMix) {
      onProgress({ phase: "audio", frame: totalFrames, totalFrames, message: "Encoding audio…" });
      try {
        await encodeAudioToMuxer(audioMix, (chunk, meta) => muxer.addAudioChunk(chunk, meta ?? undefined), "opus", config.audioBitrate, signal);
      } catch {
        // 音声 encode 失敗時も映像だけは書き出す
      }
    }

    onProgress({ phase: "pack", frame: totalFrames, totalFrames, message: "Finalizing WebM…" });
    muxer.finalize();
    onProgress({ phase: "done", frame: totalFrames, totalFrames, message: "Done" });
    return new Blob([target.buffer], { type: "video/webm" });
  } finally {
    safeCloseEncoder(videoEncoder.encoder);
  }
}

/** 全フレームを VideoEncoder に渡す共通ループ。 */
async function runWorkerVideo(
  format: "mp4" | "webm",
  comp: TimelineComposition,
  renderer: DomRenderer,
  evaluator: ExpressionEvaluator | undefined,
  startFrame: number,
  totalFrames: number,
  nw: number, nh: number, w: number, h: number,
  fps: number,
  bg: string,
  alpha: boolean,
  encoderConfig: VideoEncoderConfig,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<Blob> {
  const session = await createWorkerVideoExportSession({ format, width: w, height: h, fps, alpha, encoderConfig }, signal);
  const usDuration = Math.round(1_000_000 / fps);
  try {
    for (let fi = 0; fi < totalFrames; fi++) {
      checkAbort(signal);
      const frame = startFrame + fi;
      renderer.renderFrame(resolve(comp, frame, { expressions: evaluator }), frame);
      onProgress({ phase: "render", frame: fi, totalFrames, message: `Rendering frame ${fi + 1}/${totalFrames}` });
      await renderer.flushRasterEffects();
      await renderer.flushVideoFrames();
      await nextTick();
      const canvas = await compositeExportFrame(renderer, nw, nh, w, h, bg, {
        enableGpuCompositor: !alpha,
        directGpuSurface: !alpha && isGpuDirectSurfaceEnabled(),
        cacheStaticLayerCaptures: isStaticLayerCaptureCacheEnabled(),
        directVideoCaptures: !alpha && isDirectVideoCaptureEnabled(),
        directSolidCaptures: !alpha && isDirectSolidCaptureEnabled(),
        directImageCaptures: !alpha && isDirectImageCaptureEnabled(),
      });
      const videoFrame = new VideoFrame(canvas, {
        timestamp: fi * usDuration,
        duration: usDuration,
      });
      await session.encode(videoFrame, fi, fi === 0 || fi % 30 === 0, signal);
    }
    const result = await session.finish(signal);
    const g = globalThis as { __mafterWorkerVideoExportFrames?: number };
    g.__mafterWorkerVideoExportFrames = (g.__mafterWorkerVideoExportFrames ?? 0) + totalFrames;
    onProgress({ phase: "done", frame: totalFrames, totalFrames, message: "Done" });
    return new Blob([result.buffer], { type: result.mimeType });
  } catch (error) {
    session.abort();
    throw error;
  }
}

async function encodeVideoFrames(
  comp: TimelineComposition,
  renderer: DomRenderer,
  evaluator: ExpressionEvaluator | undefined,
  startFrame: number,
  totalFrames: number,
  nw: number, nh: number, w: number, h: number,
  fps: number,
  bg: string,
  videoEncoder: { encoder: VideoEncoder; stats: VideoEncodeStats },
  enableGpuCompositor: boolean,
  directGpuSurface: boolean,
  extraRenderers: DomRenderer[],
  onProgress: ProgressCallback,
  signal?: AbortSignal,
) {
  const { encoder, stats } = videoEncoder;
  const usDuration = Math.round(1_000_000 / fps);

  // frame 昇順に encoder へ渡す consumer（timestamp / keyframe は fi のみで決まるので順序が正）。
  const encodeInOrder = async (fi: number, canvas: HTMLCanvasElement): Promise<void> => {
    if (stats.error) throw stats.error;
    if (encoder.state === "closed") throw new Error("VideoEncoder closed unexpectedly");
    const vf = new VideoFrame(canvas, { timestamp: fi * usDuration, duration: usDuration });
    // キーフレーム: 先頭 + 30 フレームごと
    encoder.encode(vf, { keyFrame: fi === 0 || fi % 30 === 0 });
    vf.close();
    await waitForEncoderQueueAtMost(encoder, 6, signal);
  };

  if (extraRenderers.length > 0) {
    // §11.2 Phase 6 — 複数 context で並行描画。GPU / direct capture 系とは排他（純 Canvas2D）。
    const contexts = [renderer, ...extraRenderers];
    let rendered = 0;
    const res = await runOrderedMultiContext({
      producers: contexts.map((r) => (frame: number) =>
        renderContextFrameCanvas(r, comp, evaluator, frame, nw, nh, w, h, bg, {})),
      totalFrames,
      startFrame,
      onRendered: () => {
        rendered++;
        onProgress({ phase: "render", frame: rendered - 1, totalFrames, message: `Rendering frame ${rendered}/${totalFrames}` });
      },
      onFrame: encodeInOrder,
      checkAbort: () => checkAbort(signal),
    });
    recordMultiContextFrames(totalFrames, res.contextFrameCounts);
    return;
  }

  for (let fi = 0; fi < totalFrames; fi++) {
    checkAbort(signal);
    if (stats.error) throw stats.error;
    if (encoder.state === "closed") {
      throw new Error("VideoEncoder closed unexpectedly");
    }

    const frame = startFrame + fi;
    renderer.renderFrame(resolve(comp, frame, { expressions: evaluator }), frame);
    onProgress({ phase: "render", frame: fi, totalFrames, message: `Rendering frame ${fi + 1}/${totalFrames}` });

    // レイヤ直付け raster の完了のみ待つ。調整合成は compositeExportFrame が行う。
    await renderer.flushRasterEffects();
    await renderer.flushVideoFrames();
    await nextTick();

    const canvas = await compositeExportFrame(renderer, nw, nh, w, h, bg, {
      enableGpuCompositor,
      directGpuSurface,
      cacheStaticLayerCaptures: isStaticLayerCaptureCacheEnabled(),
      directVideoCaptures: enableGpuCompositor && isDirectVideoCaptureEnabled(),
      directSolidCaptures: enableGpuCompositor && isDirectSolidCaptureEnabled(),
      directImageCaptures: enableGpuCompositor && isDirectImageCaptureEnabled(),
    });
    const vf = new VideoFrame(canvas, {
      timestamp: fi * usDuration,
      duration: usDuration,
    });
    // キーフレーム: 先頭 + 30 フレームごと
    encoder.encode(vf, { keyFrame: fi === 0 || fi % 30 === 0 });
    vf.close();

    await waitForEncoderQueueAtMost(encoder, 6, signal);
  }
}

// ─── Audio mix + encode ───────────────────────────────────────────────────────

export interface AudioMixResult {
  buffer: AudioBuffer;
  sampleRate: number;
  numberOfChannels: number;
}

interface AudioMixTask {
  hasAudioSources: boolean;
  promise: Promise<AudioMixResult | null>;
}

export function isAudioMixOverlapEnabled(): boolean {
  const g = globalThis as { __mafterAudioMixOverlap?: unknown };
  return g.__mafterAudioMixOverlap === true;
}

function createAudioMixTask(
  project: Project,
  comp: TimelineComposition,
  startFrame: number,
  endFrame: number,
  fps: number,
  fs: FileSystem,
): AudioMixTask {
  const resolveComp = (compId: string): TimelineComposition | undefined => {
    const candidate = project.compositions.find((composition) => composition.id === compId);
    return candidate && candidate.kind === "timeline" ? candidate : undefined;
  };
  const mixSources = collectFootageAudioSources(comp, resolveComp);
  if (mixSources.length === 0) return { hasAudioSources: false, promise: Promise.resolve(null) };
  const promise = buildAudioMix(project, comp, startFrame, endFrame, fps, fs, mixSources);
  void promise.catch(() => { /* consumed after video encode */ });
  return { hasAudioSources: true, promise };
}

/** timeline の audio / video 内蔵音声コンポーネントを OfflineAudioContext で mix する。 */
async function buildAudioMix(
  project: Project,
  comp: TimelineComposition,
  startFrame: number,
  endFrame: number,
  fps: number,
  fs: FileSystem,
  mixSources: ReturnType<typeof collectFootageAudioSources>,
): Promise<AudioMixResult | null> {
  if (typeof OfflineAudioContext === "undefined") return null;

  // §11.5.2 カット端 declick の抑制判定（シームレス境界の二重フェード防止）。preview と同一純関数。
  const fadeSuppression = computeFadeSuppression(collectFadeClips(comp));

  const durationSec = (endFrame - startFrame) / fps;
  // 48kHz 固定 + offCtx 自身で decode する。別 context で decode すると buffer.sampleRate が
  // offCtx と食い違い、AudioBufferSourceNode が Chrome の低品質補間リサンプラを通って
  // 音がこもる（decodeAudioData 側は高品質 sinc）。Opus はネイティブ 48k、AAC も 48k が正準。
  const sampleRate = 48000;
  const offCtx = new OfflineAudioContext(2, Math.ceil(durationSec * sampleRate), sampleRate);

  let anyLoaded = false;
  for (const { obj, assetId, inPoint, outPoint, trimStart, gainProp, componentType } of mixSources) {
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) continue;

    // §11.4b 内蔵音声は quality 非依存で常に原本から（プロキシ tier でも音声は劣化させない）。
    // raster（音声なし）は null → スキップ。
    const audioPath = resolveFootageAudioPath(asset);
    if (!audioPath) continue;

    let data: Uint8Array;
    try {
      data = await fs.read(audioPath);
    } catch { continue; }

    let decoded: AudioBuffer;
    try {
      const sliced = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      decoded = await offCtx.decodeAudioData(sliced as ArrayBuffer);
    } catch {
      // 無音動画・非対応コンテナは best-effort でスキップ（§11.4）。
      continue;
    }

    const objStartSec = Math.max(0, (inPoint - startFrame) / fps);
    const trimStartSec = trimStart / fps;
    // サブレンジ export 時: inPoint < startFrame の場合、レイヤーはすでに再生途中。
    // buffer の読み出し開始位置を (startFrame - inPoint) / fps 分だけ前進させる。
    const alreadyElapsedSec = Math.max(0, (startFrame - inPoint) / fps);
    const effectiveTrimSec = trimStartSec + alreadyElapsedSec;

    const src = offCtx.createBufferSource();
    src.buffer = decoded;
    const gainNode = offCtx.createGain();
    // §11.5 — keyframed gain をフレーム刻み automation で再現（hold/bezier easing と一致）。
    // automation は comp frame [startFrame, endFrame) を offline context 時刻に写像する。
    scheduleGainAutomation(gainNode.gain, gainProp, {
      fps,
      exportStartFrame: startFrame,
      exportEndFrame: endFrame,
    });

    const outDuration = Math.min(
      decoded.duration - effectiveTrimSec,
      (outPoint - Math.max(inPoint, startFrame)) / fps,
    );
    // §11.5.2 declick: ユーザー gain 自動化とは別の fadeGain を直列に挿し、サンプル精度のフェードを打つ。
    // preview（PreviewAudioClock）と同一の長さ・抑制で INV-2 を保つ。
    const fadeComp = obj.components.find((c) => c.type === componentType);
    const fadeGain = offCtx.createGain();
    scheduleDeclickRamps(fadeGain.gain, {
      startSec: objStartSec,
      durSec: Math.max(0, outDuration),
      fadeSec: fadeComp && isAutoFadeEnabled(fadeComp.props) ? fadeSec() : 0,
      fadeInActive: inPoint >= startFrame, // サブレンジ export で途中再生開始なら in フェード無し
      suppression: fadeSuppression.get(obj.id),
    });
    src.connect(fadeGain);
    fadeGain.connect(gainNode);
    gainNode.connect(offCtx.destination);

    src.start(objStartSec, effectiveTrimSec, Math.max(0, outDuration));
    anyLoaded = true;
  }

  if (!anyLoaded) return null;

  const rendered = await offCtx.startRendering();
  return { buffer: rendered, sampleRate: rendered.sampleRate, numberOfChannels: rendered.numberOfChannels };
}

/** AudioBuffer → AudioEncoder → muxer の addAudioChunk に渡す。 */
export async function encodeAudioToMuxer(
  mix: AudioMixResult,
  addChunk: (chunk: EncodedAudioChunk, meta: EncodedAudioChunkMetadata | undefined) => void,
  codec: string,
  bitrate: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof AudioEncoder === "undefined") return;

  const encoder = new AudioEncoder({
    output: (chunk, meta) => addChunk(chunk, meta ?? undefined),
    error: (e) => { throw e; },
  });
  encoder.configure({
    codec,
    numberOfChannels: mix.numberOfChannels,
    sampleRate: mix.sampleRate,
    bitrate: resolveAudioBitrate(bitrate),
  });

  const buf = mix.buffer;
  const chunkSize = 1024;
  const totalSamples = buf.length;

  for (let offset = 0; offset < totalSamples; offset += chunkSize) {
    checkAbort(signal);
    const end = Math.min(offset + chunkSize, totalSamples);
    const frames = end - offset;
    const interleaved = new Float32Array(frames * mix.numberOfChannels);
    for (let ch = 0; ch < mix.numberOfChannels; ch++) {
      const chData = buf.getChannelData(ch);
      for (let i = 0; i < frames; i++) {
        interleaved[ch + i * mix.numberOfChannels] = chData[offset + i] ?? 0;
      }
    }
    const audioData = new AudioData({
      format: "f32",
      sampleRate: mix.sampleRate,
      numberOfChannels: mix.numberOfChannels,
      numberOfFrames: frames,
      timestamp: Math.round((offset / mix.sampleRate) * 1_000_000),
      data: interleaved,
    });
    encoder.encode(audioData);
    audioData.close();
  }

  await encoder.flush();
}

/** ExportConfig.audioBitrate を有効域に収める（未指定 = 192k）。 */
export function resolveAudioBitrate(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 192_000;
  return Math.max(32_000, Math.min(320_000, Math.round(raw)));
}

export function resolveMp4FastStart(
  totalFrames: number,
  hasAudio: boolean,
  durationSec: number,
): "in-memory" | { expectedVideoChunks: number; expectedAudioChunks?: number } {
  const g = globalThis as { __mafterMp4ReservedFastStart?: unknown };
  if (g.__mafterMp4ReservedFastStart === false) return "in-memory";
  return {
    expectedVideoChunks: Math.max(1, Math.ceil(totalFrames)),
    ...(hasAudio ? { expectedAudioChunks: Math.max(1, Math.ceil(durationSec * 48000 / 1024) + 1) } : {}),
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Export aborted", "AbortError");
}

function nextTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), type),
  );
}

function rgbaToHex(c: { r: number; g: number; b: number; a: number }): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/**
 * 解像度・fps から必要十分な AVC (H.264) codec 文字列を組む。
 * Constrained Baseline (42e0xx)。level は MaxMBPS / MaxFS（H.264 Table A-1）から決める。
 * 固定 level だと高解像度で "coded area exceeds maximum" エラーになるため動的に選ぶ。
 */
export function avcCodecString(w: number, h: number, fps: number): string {
  const mbW = Math.ceil(w / 16);
  const mbH = Math.ceil(h / 16);
  const frameMbs = mbW * mbH;
  const mbps = frameMbs * Math.max(1, fps);
  // [level_idc, MaxFS(マクロブロック), MaxMBPS]（H.264 Table A-1）
  const levels: Array<[number, number, number]> = [
    [0x1f, 36864, 108000],    // 3.1  (≈ 720p@30 まで)
    [0x20, 36864, 216000],    // 3.2
    [0x28, 139264, 245760],   // 4.0  (1080p@30)
    [0x29, 139264, 245760],   // 4.1
    [0x2a, 139264, 522240],   // 4.2  (1080p@60)
    [0x32, 696320, 589824],   // 5.0
    [0x33, 696320, 983040],   // 5.1  (4K@30)
    [0x34, 696320, 2073600],  // 5.2  (4K@60)
  ];
  let chosen = levels[levels.length - 1]![0];
  for (const [idc, maxFs, maxMbps] of levels) {
    if (frameMbs <= maxFs && mbps <= maxMbps) { chosen = idc; break; }
  }
  return `avc1.42e0${chosen.toString(16).padStart(2, "0")}`;
}

/**
 * VideoEncoder を configure する。hardwareAcceleration を強制すると、ハードウェア
 * エンコーダが無い環境（headless / 一部 GPU）で configure が非同期に失敗し codec が
 * 閉じる（"encode on a closed codec"）。isConfigSupported で hardware → no-preference →
 * software の順に試し、最初に supported な設定で configure する。
 */
export async function configureVideoEncoder(
  encoder: VideoEncoder,
  base: VideoEncoderConfig,
): Promise<void> {
  const prefs: (HardwareAcceleration | undefined)[] = [
    "prefer-hardware",
    undefined,
    "prefer-software",
  ];
  for (const accel of prefs) {
    const cfg: VideoEncoderConfig = accel ? { ...base, hardwareAcceleration: accel } : { ...base };
    try {
      const support = await VideoEncoder.isConfigSupported(cfg);
      if (support.supported) {
        // isConfigSupported が返す support.config は「ブラウザが認識したフィールドだけの
        // 正規化コピー」で、colorSpace のような未エコーなフィールドを黙って落とすことが
        // 実測で判明した（§16.2b 色空間ポリシー）。呼び出し側が明示した colorSpace は
        // support.config の有無に関わらず必ず configure() まで届くようにする。
        const finalConfig = support.config ?? cfg;
        encoder.configure(base.colorSpace ? { ...finalConfig, colorSpace: base.colorSpace } : finalConfig);
        return;
      }
    } catch {
      // isConfigSupported 自体が throw する codec もある（次の候補へ）
    }
  }
  throw new Error(`No supported VideoEncoder config for codec ${base.codec} at ${base.width}x${base.height}`);
}

function evenDim(n: number): number {
  const rounded = Math.max(2, Math.round(n));
  return rounded & ~1;
}

function createVideoEncoder(
  onChunk: (chunk: EncodedVideoChunk, meta: EncodedVideoChunkMetadata | undefined) => void,
): { encoder: VideoEncoder; stats: VideoEncodeStats } {
  const stats: VideoEncodeStats = { chunkCount: 0, hasDecoderConfig: false, error: null };
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      stats.chunkCount++;
      if (meta?.decoderConfig) stats.hasDecoderConfig = true;
      onChunk(chunk, meta ?? undefined);
    },
    error: (e) => {
      stats.error = e instanceof Error ? e : new Error(String(e));
    },
  });
  return { encoder, stats };
}

function safeCloseEncoder(encoder: VideoEncoder): void {
  try {
    if (encoder.state !== "closed") encoder.close();
  } catch {
    /* ignore */
  }
}
