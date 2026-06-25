// §11.2 Export — browser best-effort
// 決定論 frame ステップ → DOM→raster (SVG foreignObject) → WebCodecs encode / PNG seq
// Audio: OfflineAudioContext mix → AudioEncoder → mux

import JSZip from "jszip";
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from "mp4-muxer";
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from "webm-muxer";
import { compositionDir } from "../core/paths";
import type { ExportConfig, HtmlComposition, Project, TimelineComposition } from "../core/schema";
import type { FileSystem } from "../fs/FileSystem";
import { DomRenderer } from "./DomRenderer";
import { FontOutlineCache } from "./fontOutlineCache";
import { ImageAssetCache } from "./imageAssetCache";
import { ExpressionEngine } from "./expressionEngine";
import { HtmlCompPlayer } from "./htmlComp";
import { ModuleLoader } from "./moduleLoader";
import { resolve, type ExpressionEvaluator } from "./resolve";
import { captureElementToCanvas } from "./rasterCapture";
import { blendModeToCompositeOp } from "./blendCompose";

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
export async function exportComposition(
  project: Project,
  compId: string,
  fs: FileSystem,
  config: ExportConfig,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
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

  try {
    const loader = new ModuleLoader(fs);
    const engine = new ExpressionEngine(loader);
    const htmlLoader = new ModuleLoader(fs);
    const player = new HtmlCompPlayer(htmlLoader);
    const renderer = new DomRenderer();
    renderer.setHtmlPlayer(player);
    // §27.4 / INV-2 — captureElementToCanvas（foreignObject）は backdrop-filter 非対応のため、
    // Live 調整も export では comp 背面 capture + filter 適用の bake 経路（forceAdjustmentRaster）
    // を使い preview と同じ見た目を再現する。3D ネスト comp（カメラリグ）下地は
    // captureAdjustmentBackdrop 内の data-has-camera-rig 検出 + 個別 flatten で対応済み。
    renderer.setPreviewRenderOptions({ forceAdjustmentRaster: true });
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
    await Promise.all([
      engine.prepare(tlComp).then(() => { evaluator = engine.makeEvaluator(tlComp); }),
      // §23.3b: ネスト comp の expression も export で評価する（preview と一致・INV-2）。
      Promise.all(timelineComps.map((c) => engine.prepare(c))).then(() => {
        renderer.setCompEvaluators(new Map(timelineComps.map((c) => [c.id, engine.makeEvaluator(c)])));
      }),
      player.prepare(htmlComps, (id) => `${compositionDir(id)}/script.js`),
    ]);

    checkAbort(signal);

    if (config.format === "png-seq") {
      const blob = await runPngSeq(
        tlComp, renderer, evaluator, config,
        startFrame, totalFrames, nw, nh, w, h, onProgress, signal,
      );
      return { blob, format: "png-seq" };
    } else {
      // Audio assets を先に収集・デコード（OfflineAudioContext が必要なため）
      const audioMix = await buildAudioMix(project, tlComp, startFrame, endFrame, config.fps, fs);
      try {
        const blob = await runVideo(
          tlComp, renderer, evaluator, config,
          startFrame, totalFrames, nw, nh, w, h, audioMix, onProgress, signal,
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
          startFrame, totalFrames, nw, nh, w, h, onProgress, signal,
        );
        return { blob, format: "png-seq", fallbackReason: reason };
      }
    }
  } finally {
    container.remove();
  }
}

// ─── Frame capture ────────────────────────────────────────────────────────────

/**
 * container の DOM コンテンツを SVG foreignObject 経由で canvas にラスタ化する。
 * Shadow DOM は inline に展開して foreignObject に含める（§7 HTML comp 対応）。
 * transform-style:preserve-3d は foreignObject 非対応 → best-effort 制約として記録。
 */
async function captureFrame(
  container: HTMLElement,
  nw: number,
  nh: number,
  w: number,
  h: number,
  bg: string,
): Promise<HTMLCanvasElement> {
  return captureElementToCanvas(container, nw, nh, bg, w, h);
}

/**
 * §5.4d capture — comp に CSS mix-blend レイヤーがあれば各レイヤーを個別キャプチャし、
 * Canvas 2D globalCompositeOperation で z 順に合成し直す（foreignObject は backdrop 合成を
 * しないため・INV-2）。blend が無ければ従来の単一スナップショット高速経路を使う。
 * ditherDissolve は mask で焼き済みのため高速経路のままで正しく出る。
 */
async function captureRendererFrame(
  renderer: DomRenderer,
  nw: number,
  nh: number,
  w: number,
  h: number,
  bg: string,
): Promise<HTMLCanvasElement> {
  const root = renderer.getRoot()!;
  if (!renderer.hasCssBlendLayers()) {
    return captureFrame(root, nw, nh, w, h, bg);
  }

  const master = document.createElement("canvas");
  master.width = w;
  master.height = h;
  const ctx = master.getContext("2d")!;
  if (bg !== "transparent") {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
  }
  for (const { div, blendMode } of renderer.getCompositeLayers()) {
    // 各レイヤーを透明背景でラスタ化 → 累積結果へ blend して重ねる。
    const layer = await captureElementToCanvas(div, nw, nh, "transparent", w, h);
    ctx.globalCompositeOperation = blendModeToCompositeOp(blendMode);
    ctx.drawImage(layer, 0, 0);
  }
  ctx.globalCompositeOperation = "source-over";
  return master;
}

// flattenShadow / svgToDataUrl は rasterCapture.ts に移動済み（下記は削除）

// ─── PNG sequence ─────────────────────────────────────────────────────────────

async function runPngSeq(
  comp: TimelineComposition,
  renderer: DomRenderer,
  evaluator: ExpressionEvaluator | undefined,
  config: ExportConfig,
  startFrame: number,
  totalFrames: number,
  nw: number, nh: number, w: number, h: number,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<Blob> {
  const zip = new JSZip();
  const bg = config.alpha ? "transparent" : (comp.background ? rgbaToHex(comp.background) : "#000000");

  for (let fi = 0; fi < totalFrames; fi++) {
    checkAbort(signal);
    const frame = startFrame + fi;
    renderer.renderFrame(resolve(comp, frame, { expressions: evaluator }), frame);
    onProgress({ phase: "render", frame: fi, totalFrames, message: `Frame ${fi + 1}/${totalFrames}` });

    await renderer.flushExportComposite();
    // DOM が描画される次ティックまで待つ
    await nextTick();

    const canvas = await captureRendererFrame(renderer, nw, nh, w, h, bg);
    const pngBlob = await canvasToBlob(canvas, "image/png");
    zip.file(`frame_${String(fi).padStart(6, "0")}.png`, pngBlob);
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
  audioMix: AudioMixResult | null,
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
  const hasAudio = audioMix !== null;

  // ─ muxer セットアップ ─
  type ChunkAccum = { chunk: EncodedVideoChunk; meta: EncodedVideoChunkMetadata | undefined }[];
  const videoChunks: ChunkAccum = [];

  if (config.format === "mp4") {
    return await runMp4(
      comp, renderer, evaluator, config, startFrame, totalFrames,
      nw, nh, w, h, fps, bg, hasAudio, audioMix, videoChunks, onProgress, signal,
    );
  } else {
    return await runWebm(
      comp, renderer, evaluator, config, startFrame, totalFrames,
      nw, nh, w, h, fps, bg, hasAudio, audioMix, videoChunks, onProgress, signal,
    );
  }
}

async function runMp4(
  comp: TimelineComposition,
  renderer: DomRenderer,
  evaluator: ExpressionEvaluator | undefined,
  _config: ExportConfig,
  startFrame: number,
  totalFrames: number,
  nw: number, nh: number, w: number, h: number,
  fps: number,
  bg: string,
  hasAudio: boolean,
  audioMix: AudioMixResult | null,
  _videoChunks: unknown[],
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<Blob> {
  const target = new Mp4Target();
  const muxer = new Mp4Muxer({
    target,
    video: { codec: "avc", width: w, height: h, frameRate: fps },
    ...(hasAudio && audioMix ? {
      audio: { codec: "aac", numberOfChannels: audioMix.numberOfChannels, sampleRate: audioMix.sampleRate },
    } : {}),
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  const videoEncoder = createVideoEncoder((chunk, meta) => {
    muxer.addVideoChunk(chunk, meta);
  });
  try {
    await configureVideoEncoder(videoEncoder.encoder, {
      // AVC level は解像度に合わせて選ぶ。固定 3.1 だと 1080p で coded-area 超過エラーになる。
      codec: avcCodecString(w, h, fps),
      width: w,
      height: h,
      bitrate: 8_000_000,
      framerate: fps,
    });

    await encodeVideoFrames(
      comp, renderer, evaluator, startFrame, totalFrames, nw, nh, w, h, fps, bg,
      videoEncoder, onProgress, signal,
    );
    await videoEncoder.encoder.flush();
    if (videoEncoder.stats.error) throw videoEncoder.stats.error;

    if (hasAudio && audioMix) {
      onProgress({ phase: "audio", frame: totalFrames, totalFrames, message: "Encoding audio…" });
      try {
        await encodeAudioToMuxer(audioMix, (chunk, meta) => muxer.addAudioChunk(chunk, meta ?? undefined), "mp4a.40.2", signal);
      } catch {
        // 音声 encode 失敗時も映像だけは書き出す（PNG-seq フォールバックは避ける）
      }
    }

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
  audioMix: AudioMixResult | null,
  _videoChunks: unknown[],
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<Blob> {
  const target = new WebmTarget();
  const muxer = new WebmMuxer({
    target,
    video: { codec: "V_VP9", width: w, height: h, frameRate: fps, alpha: config.alpha },
    ...(hasAudio && audioMix ? {
      audio: { codec: "A_OPUS", numberOfChannels: audioMix.numberOfChannels, sampleRate: audioMix.sampleRate },
    } : {}),
  });

  const videoEncoder = createVideoEncoder((chunk, meta) => {
    muxer.addVideoChunk(chunk, meta);
  });
  try {
    await configureVideoEncoder(videoEncoder.encoder, {
      codec: "vp09.00.10.08",
      width: w,
      height: h,
      bitrate: 8_000_000,
      framerate: fps,
      alpha: config.alpha ? "keep" : "discard",
    });

    await encodeVideoFrames(
      comp, renderer, evaluator, startFrame, totalFrames, nw, nh, w, h, fps, bg,
      videoEncoder, onProgress, signal,
    );
    await videoEncoder.encoder.flush();
    if (videoEncoder.stats.error) throw videoEncoder.stats.error;

    if (hasAudio && audioMix) {
      onProgress({ phase: "audio", frame: totalFrames, totalFrames, message: "Encoding audio…" });
      try {
        await encodeAudioToMuxer(audioMix, (chunk, meta) => muxer.addAudioChunk(chunk, meta ?? undefined), "opus", signal);
      } catch {
        // 音声 encode 失敗時も映像だけは書き出す
      }
    }

    muxer.finalize();
    onProgress({ phase: "done", frame: totalFrames, totalFrames, message: "Done" });
    return new Blob([target.buffer], { type: "video/webm" });
  } finally {
    safeCloseEncoder(videoEncoder.encoder);
  }
}

/** 全フレームを VideoEncoder に渡す共通ループ。 */
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
  onProgress: ProgressCallback,
  signal?: AbortSignal,
) {
  const { encoder, stats } = videoEncoder;
  const usDuration = Math.round(1_000_000 / fps);

  for (let fi = 0; fi < totalFrames; fi++) {
    checkAbort(signal);
    if (stats.error) throw stats.error;
    if (encoder.state === "closed") {
      throw new Error("VideoEncoder closed unexpectedly");
    }

    const frame = startFrame + fi;
    renderer.renderFrame(resolve(comp, frame, { expressions: evaluator }), frame);
    onProgress({ phase: "render", frame: fi, totalFrames, message: `Rendering frame ${fi + 1}/${totalFrames}` });

    await renderer.flushExportComposite();
    await nextTick();

    const canvas = await captureRendererFrame(renderer, nw, nh, w, h, bg);
    const bitmap = await createImageBitmap(canvas);
    const vf = new VideoFrame(bitmap, {
      timestamp: fi * usDuration,
      duration: usDuration,
    });
    // キーフレーム: 先頭 + 30 フレームごと
    encoder.encode(vf, { keyFrame: fi === 0 || fi % 30 === 0 });
    vf.close();
    bitmap.close();

    await backpressureEncoderQueue(encoder);
  }
}

// ─── Audio mix + encode ───────────────────────────────────────────────────────

interface AudioMixResult {
  buffer: AudioBuffer;
  sampleRate: number;
  numberOfChannels: number;
}

/** timeline の audio コンポーネントを OfflineAudioContext で mix する。 */
async function buildAudioMix(
  project: Project,
  comp: TimelineComposition,
  startFrame: number,
  endFrame: number,
  fps: number,
  fs: FileSystem,
): Promise<AudioMixResult | null> {
  if (typeof AudioContext === "undefined") return null;

  // audio component を持つオブジェクトを収集
  const audioLayers = comp.objects.filter((obj) =>
    obj.enabled && obj.components.some((c) => c.type === "audio"),
  );
  if (audioLayers.length === 0) return null;

  const durationSec = (endFrame - startFrame) / fps;
  const sampleRate = 44100;
  const offCtx = new OfflineAudioContext(2, Math.ceil(durationSec * sampleRate), sampleRate);
  const tmpCtx = new AudioContext();

  let anyLoaded = false;
  for (const obj of audioLayers) {
    const audioCmp = obj.components.find((c) => c.type === "audio");
    if (!audioCmp) continue;
    const assetId = audioCmp.props["asset"] as string | undefined;
    if (!assetId) continue;
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) continue;

    let data: Uint8Array;
    try {
      data = await fs.read(asset.path);
    } catch { continue; }

    let decoded: AudioBuffer;
    try {
      const sliced = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      decoded = await tmpCtx.decodeAudioData(sliced as ArrayBuffer);
    } catch { continue; }

    const trimStart = (audioCmp.props["trimStart"] as number | undefined) ?? 0;
    const gain = (audioCmp.props["gain"] as number | undefined) ?? 1;
    const objStartSec = Math.max(0, (obj.inPoint - startFrame) / fps);
    const trimStartSec = trimStart / fps;
    // サブレンジ export 時: inPoint < startFrame の場合、レイヤーはすでに再生途中。
    // buffer の読み出し開始位置を (startFrame - inPoint) / fps 分だけ前進させる。
    const alreadyElapsedSec = Math.max(0, (startFrame - obj.inPoint) / fps);
    const effectiveTrimSec = trimStartSec + alreadyElapsedSec;

    const src = offCtx.createBufferSource();
    src.buffer = decoded;
    const gainNode = offCtx.createGain();
    gainNode.gain.value = Math.max(0, Math.min(1, gain));
    src.connect(gainNode);
    gainNode.connect(offCtx.destination);

    const outDuration = Math.min(
      decoded.duration - effectiveTrimSec,
      (obj.outPoint - Math.max(obj.inPoint, startFrame)) / fps,
    );
    src.start(objStartSec, effectiveTrimSec, Math.max(0, outDuration));
    anyLoaded = true;
  }

  await tmpCtx.close();
  if (!anyLoaded) return null;

  const rendered = await offCtx.startRendering();
  return { buffer: rendered, sampleRate: rendered.sampleRate, numberOfChannels: rendered.numberOfChannels };
}

/** AudioBuffer → AudioEncoder → muxer の addAudioChunk に渡す。 */
async function encodeAudioToMuxer(
  mix: AudioMixResult,
  addChunk: (chunk: EncodedAudioChunk, meta: EncodedAudioChunkMetadata | undefined) => void,
  codec: string,
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
    bitrate: 128_000,
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
function avcCodecString(w: number, h: number, fps: number): string {
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
async function configureVideoEncoder(
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
        encoder.configure(support.config ?? cfg);
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

/**
 * キューが溢れすぎないよう間引く。毎フレーム queue===0 を待つと HW エンコーダ環境で
 * タイムアウト→ PNG-seq フォールバックになるため、閾値超過時のみ短い待機を行う。
 */
async function backpressureEncoderQueue(encoder: VideoEncoder, maxQueue = 6): Promise<void> {
  while (encoder.encodeQueueSize > maxQueue) {
    await new Promise((r) => setTimeout(r, 16));
  }
}

function safeCloseEncoder(encoder: VideoEncoder): void {
  try {
    if (encoder.state !== "closed") encoder.close();
  } catch {
    /* ignore */
  }
}
