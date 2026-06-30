// §11.5 — エディタプレビューの音声マスタークロック。
// 音声があれば AudioContext.currentTime を基準に currentFrame を算出し（INV-8）、
// 各オーディオレイヤーを inPoint/outPoint/trimStart/gain に従って AudioBufferSourceNode で鳴らす。
// scene 解決値には一切影響しない（描画フレームの timing のみを音に合わせる）。

import type { FileSystem } from "../fs/FileSystem";
import type { AnimatedProp, Frame, Project, TimelineComposition } from "../core/schema";
import { loadAudioBuffer, peekAudioBuffer } from "./audioBufferCache";
import { readGainProp, sampleGain } from "../runtime/footageAudio";
import { collectFadeClips, computeFadeSuppression, fadeSec, isAutoFadeEnabled, scheduleDeclickRamps, type FadeSuppression } from "../runtime/footageAutoFade";

interface PreparedLayer {
  objectId: string;
  buffer: AudioBuffer;
  inPoint: Frame;
  outPoint: Frame;
  trimStart: Frame;
  gainProp: AnimatedProp<number>;
  /** §11.5.2 カット端 declick（既定 ON）。 */
  autoFade: boolean;
  suppression: FadeSuppression;
}

export interface PreviewAudioClockOptions {
  fps: number;
  loopStart: Frame;
  loopEnd: Frame;
  loop: boolean;
  initialFrame: Frame;
  onFrameChange: (frame: number) => void;
  onPlaybackEnd: () => void;
  /** Draft 再生時のみ渡す。直接 render する。未指定なら frame 変更だけ（React effect が描画）。 */
  renderFrame?: (frame: number) => void | Promise<void>;
  /**
   * 再生中に live comp を返す（previewOverride / draftTransform を含む）。
   * 各 tick で gain を再評価し、編集中の Volume スライダーを再生中に反映する。未指定なら schedule 時のスナップショット。
   */
  getComp?: () => TimelineComposition;
}

/** comp 内の audio コンポーネントを集めてデコードする。1 つも無ければ null。 */
export async function prepareAudioLayers(
  project: Project,
  comp: TimelineComposition,
  fs: FileSystem,
): Promise<PreparedLayer[]> {
  const layers: PreparedLayer[] = [];
  const suppression = computeFadeSuppression(collectFadeClips(comp)); // §11.5.2 シームレス境界の二重フェード抑制
  for (const obj of comp.objects) {
    if (!obj.enabled) continue;
    const cmp = obj.components.find((c) => c.type === "audio");
    if (!cmp) continue;
    const assetId = cmp.props["asset"];
    if (typeof assetId !== "string") continue;
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) continue;
    // プリロード済みの共有バッファを使う（再生レイテンシ回避）。未デコードならここで decode。
    const buffer = peekAudioBuffer(assetId) ?? (await loadAudioBuffer(assetId, () => fs.read(asset.path)));
    if (!buffer) continue;
    layers.push({
      objectId: obj.id,
      buffer,
      inPoint: obj.inPoint,
      outPoint: obj.outPoint,
      trimStart: typeof cmp.props["trimStart"] === "number" ? (cmp.props["trimStart"] as number) : 0,
      gainProp: readGainProp(cmp.props["gain"]),
      autoFade: isAutoFadeEnabled(cmp.props),
      suppression: suppression.get(obj.id) ?? { in: false, out: false },
    });
  }
  return layers;
}

/**
 * 音声マスタークロックの再生制御。
 * - new → start() で AudioContext.resume + デコード + スケジュール + rAF ループ開始。
 * - stop() で全ノード停止・rAF 解除（同期）。
 * 音声レイヤーが 0 の場合 start() は false を返し、呼び出し側は通常の rAF クロックへフォールバックする。
 */
export class PreviewAudioClock {
  private ctx: AudioContext | null = null;
  private layers: PreparedLayer[] = [];
  private nodes: { src: AudioBufferSourceNode; gain: GainNode; objectId: string }[] = [];
  private playing = false;
  private rafId: number | null = null;
  private originCtxTime = 0;
  private originFrame = 0;

  constructor(
    private readonly project: Project,
    private readonly comp: TimelineComposition,
    private readonly fs: FileSystem,
    private readonly opts: PreviewAudioClockOptions,
  ) {}

  async start(): Promise<boolean> {
    const Ctor = window.AudioContext;
    if (!Ctor) return false;
    const ctx = new Ctor();
    this.ctx = ctx;
    try {
      await ctx.resume();
    } catch {
      /* ジェスチャ無しでも一応続行 */
    }
    this.layers = await prepareAudioLayers(this.project, this.comp, this.fs);
    if (this.layers.length === 0) {
      void ctx.close();
      this.ctx = null;
      return false;
    }
    this.playing = true;
    this.schedule(this.opts.initialFrame);
    this.rafId = requestAnimationFrame(this.tick);
    return true;
  }

  /** fromFrame から各レイヤーをスケジュールする（loop wrap 時も再呼び出し）。 */
  private schedule(fromFrame: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.stopNodes();
    const lookahead = 0.04; // 数十 ms 先から鳴らしてグリッチを避ける
    this.originCtxTime = ctx.currentTime + lookahead;
    this.originFrame = fromFrame;
    const fps = this.opts.fps;
    for (const layer of this.layers) {
      // ソース内の読み出し開始位置: trimStart + （既に再生済みの分）。
      const alreadyElapsed = Math.max(0, (fromFrame - layer.inPoint) / fps);
      const offsetSec = layer.trimStart / fps + alreadyElapsed;
      if (offsetSec >= layer.buffer.duration) continue;
      const startAtFrame = Math.max(layer.inPoint, fromFrame);
      const whenSec = this.originCtxTime + (startAtFrame - fromFrame) / fps;
      const playableByOut = (layer.outPoint - startAtFrame) / fps;
      const playableByBuffer = layer.buffer.duration - offsetSec;
      const durSec = Math.min(playableByOut, playableByBuffer);
      if (durSec <= 0) continue;
      const src = ctx.createBufferSource();
      src.buffer = layer.buffer;
      // §11.5.2 declick: ユーザー gain とは別の fadeGain を直列に挿し、サンプル精度のフェードを打つ
      // （updateLiveGains が gainNode.gain.value を毎 tick 上書きしても fadeGain のランプは stomp されない）。
      const fadeGain = ctx.createGain();
      const gainNode = ctx.createGain();
      gainNode.gain.value = sampleGain(layer.gainProp, fromFrame);
      src.connect(fadeGain);
      fadeGain.connect(gainNode);
      gainNode.connect(ctx.destination);
      scheduleDeclickRamps(fadeGain.gain, {
        startSec: whenSec,
        durSec,
        fadeSec: layer.autoFade ? fadeSec() : 0,
        fadeInActive: startAtFrame === layer.inPoint, // スクラブで途中から再生していない
        suppression: layer.suppression,
      });
      src.start(whenSec, offsetSec, durSec);
      this.nodes.push({ src, gain: gainNode, objectId: layer.objectId });
    }
  }

  private tick = (): void => {
    if (!this.playing || !this.ctx) return;
    const elapsedSec = this.ctx.currentTime - this.originCtxTime;
    const frame = this.originFrame + Math.floor(elapsedSec * this.opts.fps);
    const { loopStart, loopEnd, loop } = this.opts;
    const lastFrame = Math.max(loopStart, loopEnd - 1);

    if (frame >= lastFrame) {
      if (loop) {
        this.opts.onFrameChange(lastFrame);
        void this.opts.renderFrame?.(lastFrame);
        this.schedule(loopStart);
        this.opts.onFrameChange(loopStart);
        void this.opts.renderFrame?.(loopStart);
        this.rafId = requestAnimationFrame(this.tick);
        return;
      }
      this.playing = false;
      this.stopNodes();
      this.opts.onFrameChange(lastFrame);
      const done = this.opts.onPlaybackEnd;
      void Promise.resolve(this.opts.renderFrame?.(lastFrame)).finally(() => done());
      return;
    }

    const clamped = Math.max(loopStart, frame);
    this.updateLiveGains(clamped);
    this.opts.onFrameChange(clamped);
    void this.opts.renderFrame?.(clamped);
    this.rafId = requestAnimationFrame(this.tick);
  };

  /** 各 tick で live comp から gain を再評価し、編集中の Volume スライダーを再生中に反映する。 */
  private updateLiveGains(frame: number): void {
    const comp = this.opts.getComp?.() ?? this.comp;
    for (const node of this.nodes) {
      const obj = comp.objects.find((o) => o.id === node.objectId);
      const cmp = obj?.components.find((c) => c.type === "audio");
      const value = cmp ? sampleGain(cmp.props["gain"], frame) : node.gain.gain.value;
      node.gain.gain.value = value;
    }
  }

  private stopNodes(): void {
    for (const { src } of this.nodes) {
      try { src.stop(); } catch { /* already stopped */ }
      src.disconnect();
    }
    this.nodes = [];
  }

  stop(): void {
    this.playing = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.stopNodes();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
