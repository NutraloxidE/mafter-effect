// §11.5 — エディタプレビューの音声マスタークロック。
// 音声があれば AudioContext.currentTime を基準に currentFrame を算出し（INV-8）、
// 各オーディオレイヤーを inPoint/outPoint/trimStart/gain に従って AudioBufferSourceNode で鳴らす。
// scene 解決値には一切影響しない（描画フレームの timing のみを音に合わせる）。

import type { FileSystem } from "../fs/FileSystem";
import type { AnimatedProp, Frame, Project, TimelineComposition } from "../core/schema";
import { loadAudioBuffer, peekAudioBuffer } from "./audioBufferCache";
import { collectFootageAudioSources, sampleGain } from "../runtime/footageAudio";
import { collectFadeClips, computeFadeSuppression, fadeSec, isAutoFadeEnabled, scheduleDeclickRamps, type FadeSuppression } from "../runtime/footageAutoFade";
import {
  computePlaybackSyncState,
  holdThresholdsForFps,
  initialPlaybackSyncState,
  type PlaybackSyncState,
  type VideoClockSample,
} from "../runtime/playbackVideoSync";

export interface PreparedLayer {
  objectId: string;
  /**
   * Phase B（doc/issue/static-noise-problem/after-v3-implement-report.md §4）: standalone `audio`
   * レイヤーに加え、内蔵音声を持つ `video` レイヤーもここに含まれる。componentType="video" のレイヤーは
   * 表示 <video> を持続ミュートする対象（PreviewPanel が getMutedVideoObjectIds() 経由で参照）。
   */
  componentType: "audio" | "video";
  buffer: AudioBuffer;
  inPoint: Frame;
  outPoint: Frame;
  trimStart: Frame;
  gainProp: AnimatedProp<number>;
  /** §11.5.2 カット端 declick（既定 ON）。 */
  autoFade: boolean;
  suppression: FadeSuppression;
}

/**
 * Phase B: この comp に standalone audio または video 内蔵音声「候補」（enabled かつ asset 設定済み）が
 * 1 つでもあるか — PreviewAudioClock を試す価値があるかの軽量ゲート。asset が実際に project に存在するか、
 * video に音声トラックが実在するかはここでは判定しない（prepareAudioLayers の decode 側の責務。
 * 候補が無ければ AudioContext を作らず従来の rAF クロックへフォールバックする）。
 */
export function hasPreviewAudioCandidates(comp: TimelineComposition): boolean {
  return collectFootageAudioSources(comp).length > 0;
}

/** Phase B: prepared レイヤーのうち video 内蔵音声を抽出したもの（表示 <video> の持続ミュート対象）の objectId 集合。 */
export function mutedVideoObjectIds(
  layers: readonly Pick<PreparedLayer, "objectId" | "componentType">[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const layer of layers) {
    if (layer.componentType === "video") ids.add(layer.objectId);
  }
  return ids;
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
  /** §11.4 playback hold — マウント video の時計サンプル。未指定なら hold 無効。 */
  getVideoClockSamples?: () => VideoClockSample[];
  /** §11.4 双方向同期 — pauseVideo 等を renderer へ伝える。 */
  onPlaybackSyncState?: (state: PlaybackSyncState) => void;
}

/**
 * comp 内の音声レイヤー（standalone `audio` + Phase B: 内蔵音声を持つ `video`）を集めてデコードする。
 * 1 つも無ければ空配列。
 *
 * video レイヤーは asset に音声トラックが無い場合 decodeAudioData が失敗し loadAudioBuffer が null を
 * 返す — その video はここで静かにスキップする（video-only-no-audio comp を壊さない。Phase B —
 * doc/issue/static-noise-problem/after-v3-implement-report.md §4）。
 */
export async function prepareAudioLayers(
  project: Project,
  comp: TimelineComposition,
  fs: FileSystem,
): Promise<PreparedLayer[]> {
  const layers: PreparedLayer[] = [];
  const suppression = computeFadeSuppression(collectFadeClips(comp)); // §11.5.2 シームレス境界の二重フェード抑制
  for (const source of collectFootageAudioSources(comp)) {
    const asset = project.assets.find((a) => a.id === source.assetId);
    if (!asset) continue;
    // プリロード済みの共有バッファを使う（再生レイテンシ回避）。未デコードならここで decode。
    const buffer = peekAudioBuffer(source.assetId) ?? (await loadAudioBuffer(source.assetId, () => fs.read(asset.path)));
    if (!buffer) continue;
    const cmp = source.obj.components.find((c) => c.type === source.componentType);
    layers.push({
      objectId: source.objectId,
      componentType: source.componentType,
      buffer,
      inPoint: source.inPoint,
      outPoint: source.outPoint,
      trimStart: source.trimStart,
      gainProp: source.gainProp,
      autoFade: cmp ? isAutoFadeEnabled(cmp.props) : true,
      suppression: suppression.get(source.objectId) ?? { in: false, out: false },
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
  private nodes: { src: AudioBufferSourceNode; gain: GainNode; objectId: string; componentType: "audio" | "video" }[] = [];
  private playing = false;
  private rafId: number | null = null;
  private originCtxTime = 0;
  private originFrame = 0;
  private syncState: PlaybackSyncState = initialPlaybackSyncState();

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
      this.nodes.push({ src, gain: gainNode, objectId: layer.objectId, componentType: layer.componentType });
    }
  }

  /**
   * Phase B: 音声を抽出済みの video レイヤーの objectId 集合。呼び出し側（PreviewPanel）が
   * renderer.setPreviewRenderOptions({ persistentlyMutedVideoIds }) に渡し、表示 <video> の
   * 二重再生（ネイティブ音声 + このクロック）を防ぐ。start() が false のとき、または video 内蔵
   * 音声レイヤーが 0 のときは空集合。
   */
  getMutedVideoObjectIds(): ReadonlySet<string> {
    return mutedVideoObjectIds(this.layers);
  }

  private tick = (): void => {
    if (!this.playing || !this.ctx) return;

    // §16.2/§16.2b フリーズ対策: onFrameChange/renderFrame 等が同期例外を投げると、catch が無ければ
    // この tick が末尾の requestAnimationFrame(this.tick) 再スケジュールに届かず、再生が二度と
    // 進まない恒久フリーズになる（bundle 側 BundleAudioClock/previewPlaybackLoop と同型の自己修復）。
    try {
      // §11.4 双方向同期: holdTimeline（映像遅れ）は pauseVideo 判定の副産物として算出・報告する
      // だけで、AudioContext の suspend/resume や frame 進行の凍結には使わない（audio-master、
      // doc/issue/static-noise-problem/after-v3-implement-report.md Phase A）。
      const samples = this.opts.getVideoClockSamples?.() ?? [];
      this.syncState = computePlaybackSyncState(
        this.syncState,
        samples,
        holdThresholdsForFps(this.opts.fps),
        performance.now(),
      );
      this.opts.onPlaybackSyncState?.(this.syncState);

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
    } catch (err) {
      console.error("PreviewAudioClock: tick failed", err);
    } finally {
      if (this.playing) this.rafId = requestAnimationFrame(this.tick);
    }
  };

  /**
   * 各 tick で live comp から gain を再評価し、編集中の Volume スライダーを再生中に反映する。
   * Phase B: node は standalone audio でも video 内蔵音声でもありうるため、node.componentType で
   * 正しいコンポーネント（"audio" or "video"）の gain prop を読む（video を "audio" 決め打ちで
   * 探すと見つからず live 更新が効かなくなる）。
   */
  private updateLiveGains(frame: number): void {
    const comp = this.opts.getComp?.() ?? this.comp;
    for (const node of this.nodes) {
      const obj = comp.objects.find((o) => o.id === node.objectId);
      const cmp = obj?.components.find((c) => c.type === node.componentType);
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
    this.syncState = initialPlaybackSyncState();
    this.opts.onPlaybackSyncState?.(this.syncState);
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.stopNodes();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
