import type { AnimatedProp, Frame, Project, TimelineComposition } from "../core/schema";
import { readGainProp, sampleGain } from "../runtime/footageAudio";
import { autoFadeMultiplierAtFrame, collectFadeClips, computeFadeSuppression, isAutoFadeEnabled, type FadeSuppression } from "../runtime/footageAutoFade";
import {
  computePlaybackSyncState,
  computePlaybackRateForSync,
  dominantVideoSyncErrorSec,
  holdThresholdsForFps,
  initialPlaybackSyncState,
  type PlaybackSyncState,
  type VideoClockSample,
} from "../runtime/playbackVideoSync";

/** §11.4 preview と同じ双方向同期を bundle にも配線するためのコールバック（省略可＝同期無効）。 */
export interface BundleAudioClockSyncOptions {
  audioMaster?: boolean;
  getVideoClockSamples?: () => VideoClockSample[];
  onPlaybackSyncState?: (state: PlaybackSyncState) => void;
  onPlaybackRate?: (rate: number) => void;
}

/**
 * hold 中に unlock() が使う seek 先（秒）を純関数として切り出したもの（unit test 用）。
 * frozenFrame があれば hold 中＝そこから算出（startWallMs はまだ再アンカーされていないため
 * 生の wall-clock 経過を使うと音声だけ先行した位置に seek されてしまう）。無ければ従来どおり
 * wall-clock 経過（autoplay ブロックのみで hold ではない場合と同じ計算）。
 */
export function bundleAudioUnlockElapsedSec(
  frozenFrame: number | null,
  rangeStart: number,
  fps: number,
  startWallMs: number,
  nowMs: number,
): number {
  if (frozenFrame !== null) {
    return Math.max(0, (frozenFrame - rangeStart) / fps);
  }
  return Math.max(0, (nowMs - startWallMs) / 1000);
}

/**
 * hold 解除時の startWallMs 再アンカー（純関数）。held 分だけ起点を前進させることで、
 * 解除直後に計算される frame が hold 開始直前の frame と連続する（ジャンプしない）。
 */
export function reanchorStartWallMsAfterHold(
  startWallMs: number,
  holdEnteredWallMs: number,
  releaseNowMs: number,
): number {
  return startWallMs + (releaseNowMs - holdEnteredWallMs);
}

export interface AudioLayerSpec {
  objectId: string;
  assetPath: string;
  inPoint: Frame;
  outPoint: Frame;
  trimStart: Frame;
  gainProp: AnimatedProp<number>;
  /** §11.5.2 カット端 declick（既定 ON・best-effort: volume 粒度）。 */
  autoFade: boolean;
  suppression: FadeSuppression;
}

interface LayerGainInfo {
  gainProp: AnimatedProp<number>;
  inPoint: Frame;
  outPoint: Frame;
  autoFade: boolean;
  suppression: FadeSuppression;
}

/** §11.7 — 音声マスタークロック。HTMLAudioElement で file:// 互換再生。 */
export class BundleAudioClock {
  private readonly elements = new Map<string, HTMLAudioElement>();
  private readonly gainByObjectId = new Map<string, LayerGainInfo>();
  private startWallMs = 0;
  private playing = false;
  private rafId: number | null = null;
  private onFrame: ((frame: number) => void) | null = null;
  private onEnded: (() => void) | null = null;
  /** §11.4 双方向同期状態。sync が未指定なら getVideoClockSamples が常に [] を返すため常に非 hold。 */
  private syncState: PlaybackSyncState = initialPlaybackSyncState();
  /** hold 中に報告し続けるフレーム（audio 要素は pause 中で currentTime が進まないため）。 */
  private frozenFrame: number | null = null;
  /** hold に入った wall-clock 時刻（解除時に startWallMs を前進させる分の計測用）。 */
  private holdEnteredWallMs: number | null = null;

  constructor(
    private readonly fps: number,
    private readonly rangeStart: Frame,
    private readonly rangeEnd: Frame,
    private readonly urlForPath: (path: string) => string,
    private readonly loop: boolean,
    private readonly sync?: BundleAudioClockSyncOptions,
  ) {}

  async prepare(project: Project, comp: TimelineComposition): Promise<boolean> {
    const layers = collectAudioLayers(project, comp);
    if (layers.length === 0) return false;

    for (const layer of layers) {
      const audio = document.createElement("audio");
      audio.src = this.urlForPath(layer.assetPath);
      audio.preload = "auto";
      audio.volume = sampleGain(layer.gainProp, this.rangeStart);
      this.gainByObjectId.set(layer.objectId, {
        gainProp: layer.gainProp,
        inPoint: layer.inPoint,
        outPoint: layer.outPoint,
        autoFade: layer.autoFade,
        suppression: layer.suppression,
      });
      this.elements.set(layer.objectId, audio);
      try {
        await audio.play();
        audio.pause();
        audio.currentTime = 0;
      } catch {
        /* autoplay policy — unmute on user gesture if needed */
      }
    }
    return true;
  }

  setFrameCallback(cb: (frame: number) => void): void {
    this.onFrame = cb;
  }

  setEndedCallback(cb: () => void): void {
    this.onEnded = cb;
  }

  play(fromFrame: Frame): void {
    this.playing = true;
    this.syncState = initialPlaybackSyncState();
    this.frozenFrame = null;
    this.holdEnteredWallMs = null;
    this.startWallMs = performance.now() - (fromFrame - this.rangeStart) * (1000 / this.fps);
    for (const [id, el] of this.elements) {
      void id;
      try {
        el.currentTime = Math.max(0, (fromFrame - this.rangeStart) / this.fps);
        void el.play();
      } catch {
        /* ignore */
      }
    }
    this.tick();
  }

  /**
   * autoplay がブラウザにブロックされた後、最初のユーザー操作で音声を現在位置から鳴らす。
   * tick ループは再始動しない（play() を再呼び出しすると rAF が二重化するため）。
   * 既に鳴っている要素は触らず、pause 中（autoplay 拒否 or §11.4 hold）の要素だけ
   * 現在の再生位置へ seek して play する。
   */
  unlock(): void {
    if (!this.playing) return;
    const elapsedSec = bundleAudioUnlockElapsedSec(
      this.frozenFrame,
      this.rangeStart,
      this.fps,
      this.startWallMs,
      performance.now(),
    );
    for (const el of this.elements.values()) {
      if (!el.paused) continue;
      try {
        el.currentTime = elapsedSec;
        void el.play();
      } catch {
        /* best-effort */
      }
    }
  }

  pause(): void {
    this.playing = false;
    this.syncState = initialPlaybackSyncState();
    this.frozenFrame = null;
    this.holdEnteredWallMs = null;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    for (const el of this.elements.values()) {
      el.pause();
    }
  }

  dispose(): void {
    this.pause();
    for (const el of this.elements.values()) {
      el.src = "";
    }
    this.elements.clear();
  }

  private tick = (): void => {
    if (!this.playing) return;

    // §11.4 双方向同期: 映像遅れ→timeline hold（音声も pause）/ 映像先行→pauseVideo。
    // sync 未指定なら samples は常に [] → 常に非 hold（既存挙動と完全互換）。
    const samples = this.sync?.getVideoClockSamples?.() ?? [];
    this.syncState = computePlaybackSyncState(
      this.syncState,
      samples,
      holdThresholdsForFps(this.fps),
      performance.now(),
    );
    this.sync?.onPlaybackRate?.(
      computePlaybackRateForSync(dominantVideoSyncErrorSec(samples), this.fps),
    );
    this.sync?.onPlaybackSyncState?.(this.syncState);
    if (this.syncState.holdTimeline && this.sync?.audioMaster === false) {
      if (this.frozenFrame === null) {
        const elapsedSec = (performance.now() - this.startWallMs) / 1000;
        this.frozenFrame = this.rangeStart + Math.floor(elapsedSec * this.fps);
        this.holdEnteredWallMs = performance.now();
        for (const el of this.elements.values()) {
          try {
            el.pause();
          } catch {
            /* best-effort */
          }
        }
      }
      // editor 同様、hold 中は onFrame を呼ばない（他レイヤーの DOM 更新も含め見た目上完全に静止する）。
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    if (this.frozenFrame !== null) {
      // hold 解除: held 分だけ起点を前進させる（frame 連続性を保つ。§11.4 previewAudioClock の
      // originFrame/originCtxTime 再アンカーと同じ考え方を wall-clock で行う）。
      if (this.holdEnteredWallMs !== null) {
        this.startWallMs = reanchorStartWallMsAfterHold(
          this.startWallMs,
          this.holdEnteredWallMs,
          performance.now(),
        );
      }
      this.frozenFrame = null;
      this.holdEnteredWallMs = null;
      for (const el of this.elements.values()) {
        try {
          void el.play();
        } catch {
          /* best-effort */
        }
      }
    }

    const elapsedSec = (performance.now() - this.startWallMs) / 1000;
    const frame = this.rangeStart + Math.floor(elapsedSec * this.fps);
    const lastFrame = this.rangeEnd - 1;
    if (frame >= lastFrame) {
      this.onFrame?.(lastFrame);
      if (this.loop) {
        this.startWallMs = performance.now();
        for (const el of this.elements.values()) {
          try {
            el.currentTime = 0;
            void el.play();
          } catch {
            /* ignore */
          }
        }
        this.rafId = requestAnimationFrame(this.tick);
      } else {
        this.playing = false;
        for (const el of this.elements.values()) el.pause();
        this.onEnded?.();
      }
      return;
    }
    this.applyGains(frame);
    this.onFrame?.(frame);
    this.rafId = requestAnimationFrame(this.tick);
  };

  /** §11.5 — keyframed gain を毎 tick で反映（bundle は previewOverride なし・comp 固定）。 */
  private applyGains(frame: number): void {
    for (const [id, el] of this.elements) {
      const info = this.gainByObjectId.get(id);
      if (!info) continue;
      let v = sampleGain(info.gainProp, frame);
      // §11.5.2 declick: best-effort（volume 粒度）。video/preview と同一の長さ・抑制で乗算。
      if (info.autoFade) {
        v *= autoFadeMultiplierAtFrame(frame, {
          inPoint: info.inPoint,
          outPoint: info.outPoint,
          fps: this.fps,
          suppression: info.suppression,
        });
      }
      el.volume = Math.max(0, Math.min(1, v));
    }
  }
}

function collectAudioLayers(project: Project, comp: TimelineComposition): AudioLayerSpec[] {
  const out: AudioLayerSpec[] = [];
  const suppression = computeFadeSuppression(collectFadeClips(comp)); // §11.5.2
  for (const obj of comp.objects) {
    if (!obj.enabled) continue;
    const audioCmp = obj.components.find((c) => c.type === "audio");
    if (!audioCmp) continue;
    const assetId = audioCmp.props["asset"];
    if (typeof assetId !== "string") continue;
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) continue;
    const trimStart = typeof audioCmp.props["trimStart"] === "number" ? audioCmp.props["trimStart"] : 0;
    out.push({
      objectId: obj.id,
      assetPath: asset.path,
      inPoint: obj.inPoint,
      outPoint: obj.outPoint,
      trimStart,
      gainProp: readGainProp(audioCmp.props["gain"]),
      autoFade: isAutoFadeEnabled(audioCmp.props),
      suppression: suppression.get(obj.id) ?? { in: false, out: false },
    });
  }
  return out;
}

export function hasAudioLayers(project: Project, comp: TimelineComposition): boolean {
  return collectAudioLayers(project, comp).length > 0;
}
