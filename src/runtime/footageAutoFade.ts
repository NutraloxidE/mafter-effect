// §11.5.2 — カット端のポップ音防止 自動フェード（declick）。純関数・DOM 非依存。
//
// video / audio レイヤーの in/out 端で gain に極短いフェードを乗算し、波形の不連続による
// クリック（ポップ）を消す。全経路（resolve→preview/bundle の video.volume / PreviewAudioClock /
// BundleAudioClock / export mux）が同じ長さ・抑制判定を共有するため INV-2（整数フレーム解像度）を保つ。
//
// 直前の §11.4「カット境界の <video> 要素再利用」で同一アセットのシームレス境界は音が連続再生
// される。そこへ out→in フェードを掛けると「音量の急落→急上昇」（ぶつ切り）を復活させてしまうため、
// 隣に同一アセットがソース時刻を連続して引き継ぐ境界ではフェードを抑制する（computeFadeSuppression）。

import type { Frame, TimelineComposition } from "../core/schema";

/** declick フェードの既定長（ミリ秒）。短いほど目立たず、長いほど確実にポップが消える。 */
export const DEFAULT_AUTO_FADE_MS = 300;

/** フェード抑制判定に必要なクリップの純データ（audio / video 共通）。 */
export interface FadeClip {
  objectId: string;
  assetId: string;
  inPoint: Frame;
  outPoint: Frame;
  /** 現状どおり plain number 読み取り（animated trimStart は既存未対応）。 */
  trimStart: Frame;
}

/** レイヤーの in/out 端それぞれでフェードを抑制すべきか（同一アセットがシームレス継続する境界）。 */
export interface FadeSuppression {
  in: boolean;
  out: boolean;
}

const NO_SUPPRESSION: FadeSuppression = { in: false, out: false };

/** prev の読み出し終端が next の読み出し始端に一致するか（同一アセットのソース時刻が連続）。 */
function continuous(prev: FadeClip, next: FadeClip): boolean {
  return prev.trimStart + (prev.outPoint - prev.inPoint) === next.trimStart;
}

/**
 * 各クリップの in/out フェード抑制を判定する（§11.4 シームレス境界の二重フェード防止）。
 * D.out==C.in かつ読み出し位置が連続 → C の in フェードを抑制（対称に out も）。
 * O(clips^2) だが clips（audio/video レイヤー数）は小さい。
 */
export function computeFadeSuppression(clips: FadeClip[]): Map<string, FadeSuppression> {
  const out = new Map<string, FadeSuppression>();
  for (const c of clips) out.set(c.objectId, { in: false, out: false });
  for (const c of clips) {
    const s = out.get(c.objectId);
    if (!s) continue;
    for (const d of clips) {
      if (d === c || d.assetId !== c.assetId) continue;
      if (d.outPoint === c.inPoint && continuous(d, c)) s.in = true; // d→c がシームレス継続
      if (d.inPoint === c.outPoint && continuous(c, d)) s.out = true; // c→d がシームレス継続
    }
  }
  return out;
}

/** timeline の enabled な audio / video レイヤーを FadeClip として列挙する。 */
export function collectFadeClips(comp: TimelineComposition): FadeClip[] {
  const clips: FadeClip[] = [];
  for (const obj of comp.objects) {
    if (!obj.enabled) continue;
    for (const componentType of ["audio", "video"] as const) {
      const cmp = obj.components.find((c) => c.type === componentType);
      if (!cmp) continue;
      const assetId = cmp.props["asset"];
      if (typeof assetId !== "string" || assetId === "") continue;
      const rawTrim = cmp.props["trimStart"];
      clips.push({
        objectId: obj.id,
        assetId,
        inPoint: obj.inPoint,
        outPoint: obj.outPoint,
        trimStart: typeof rawTrim === "number" ? rawTrim : 0,
      });
    }
  }
  return clips;
}

/** component props から autoFade が有効か（既定 true・freeform props）。 */
export function isAutoFadeEnabled(props: Record<string, unknown>): boolean {
  return props["autoFade"] !== false;
}

/** fadeMs を秒に変換（負・NaN は 0）。 */
export function fadeSec(fadeMs: number = DEFAULT_AUTO_FADE_MS): number {
  return fadeMs > 0 ? fadeMs / 1000 : 0;
}

export interface AutoFadeArgs {
  /** クリップ内の経過秒（= (frame - inPoint)/fps、フレーム中央評価なら +0.5/fps）。 */
  elapsedSec: number;
  /** クリップの可聴尺（秒）。 */
  durSec: number;
  /** フェード長（秒）。0 ならフェード無し（1 を返す）。 */
  fadeSec: number;
  suppression?: FadeSuppression;
}

/**
 * declick エンベロープ（0..1）を時間ドメインで返す（要素ベース経路の volume 乗算用）。
 * in 端: [0, fadeSec) で 0→1。out 端: (durSec-fadeSec, durSec) で 1→0。重なる場合は小さい方。
 * 形状は線形でなく cubic-bezier「slow in / fast out」（fadeEase）— 端のジッパーノイズを抑える。
 * Web Audio 経路はこの関数ではなく fadeSec / suppression を使って AudioParam に同じカーブを打つ。
 */
export function autoFadeMultiplier(args: AutoFadeArgs): number {
  const { elapsedSec, durSec, fadeSec, suppression = NO_SUPPRESSION } = args;
  if (fadeSec <= 0 || durSec <= 0) return 1;
  let m = 1;
  if (!suppression.in) {
    const t = elapsedSec / fadeSec;
    if (t < 1) m = Math.min(m, fadeEase(clamp01(t))); // 立ち上がり: slow in → fast out
  }
  if (!suppression.out) {
    // 末尾フェードの減衰進捗 a:0→1。1-fadeEase(a) で「最初はゆっくり下がり最後に速く切れる」。
    const a = (elapsedSec - (durSec - fadeSec)) / fadeSec;
    if (a > 0) m = Math.min(m, 1 - fadeEase(clamp01(a)));
  }
  return clamp01(m);
}

/**
 * 整数フレーム f における declick 乗数（resolve / 毎フレーム経路の便宜関数）。
 * フレーム中央（f+0.5）で評価し、低 fps・短フェードでも in/out 端が確実に減衰する。
 */
export function autoFadeMultiplierAtFrame(
  frame: Frame,
  opts: { inPoint: Frame; outPoint: Frame; fps: number; fadeMs?: number; suppression?: FadeSuppression },
): number {
  const fps = opts.fps > 0 ? opts.fps : 30;
  return autoFadeMultiplier({
    elapsedSec: (frame + 0.5 - opts.inPoint) / fps,
    durSec: (opts.outPoint - opts.inPoint) / fps,
    fadeSec: fadeSec(opts.fadeMs),
    suppression: opts.suppression,
  });
}

/** AudioParam の最小インターフェース（テスト・offline/realtime 両用）。 */
export interface RampableParam {
  setValueAtTime(value: number, startTime: number): void;
  linearRampToValueAtTime(value: number, endTime: number): void;
  /** あれば bezier カーブをサンプル配列で打つ（実 AudioContext / OfflineAudioContext は実装あり）。 */
  setValueCurveAtTime?(values: Float32Array, startTime: number, duration: number): void;
}

export interface DeclickRampOpts {
  /** ソースが可聴になる context 時刻（秒）。 */
  startSec: number;
  /** 可聴尺（秒）。 */
  durSec: number;
  /** フェード長（秒）。0 ならフェードを打たない。 */
  fadeSec: number;
  /** クリップが in 端から始まる（スクラブで途中から再生していない）か。false なら in フェード無し。 */
  fadeInActive: boolean;
  suppression?: FadeSuppression;
}

/**
 * Web Audio 経路（PreviewAudioClock realtime / export OfflineAudioContext）用の declick カーブを打つ。
 * 専用 fadeGain ノードに対して呼ぶ前提（ユーザー gain 自動化とはノードを分け、互いを stomp しない）。
 * setValueCurveAtTime で fadeEase（slow in / fast out）を直接サンプルするため、線形ランプより滑らかで
 * ジッパーノイズが出ない。setValueCurveAtTime が無い環境（テスト等）は線形ランプにフォールバックする。
 */
export function scheduleDeclickRamps(param: RampableParam, opts: DeclickRampOpts): void {
  const { startSec, durSec, fadeInActive, suppression = NO_SUPPRESSION } = opts;
  const start = Math.max(0, startSec);
  if (durSec <= 0) {
    param.setValueAtTime(1, start);
    return;
  }
  // in/out が重ならないようフェード長をクリップ尺の半分に制限。
  const f = Math.max(0, Math.min(opts.fadeSec, durSec / 2));
  const end = startSec + durSec;
  const doIn = f > 0 && fadeInActive && !suppression.in;
  const doOut = f > 0 && !suppression.out;
  const curve = typeof param.setValueCurveAtTime === "function";

  if (doIn && curve) {
    param.setValueCurveAtTime!(fadeCurveSamples(false), start, f); // 0→1（slow in / fast out）
  } else if (doIn) {
    param.setValueAtTime(0, start);
    param.linearRampToValueAtTime(1, start + f);
  } else {
    param.setValueAtTime(1, start);
  }

  if (doOut) {
    // out フェード開始点（in フェード後／クリップ末尾 f 秒前のうち遅い方）。
    const outStart = Math.max(start + (doIn ? f : 0), end - f);
    const outDur = end - outStart;
    if (outDur > 0 && curve) {
      param.setValueCurveAtTime!(fadeCurveSamples(true), outStart, outDur); // 1→0
    } else if (outDur > 0) {
      param.setValueAtTime(1, outStart);
      param.linearRampToValueAtTime(0, end);
    }
  }
}

// ---- cubic-bezier「slow in / fast out」イージング -------------------------------------------------

/** declick フェードのカーブ制御点（easeInCubic 相当: ゆっくり立ち上がり最後に速い）。 */
const FADE_BEZIER: readonly [number, number, number, number] = [0.32, 0, 0.67, 0];

/** setValueCurveAtTime に渡すサンプル数（端を含むので滑らかさと配列長のバランス）。 */
const FADE_CURVE_SAMPLES = 33;

/**
 * 単位区間の cubic-bezier(x1,y1,x2,y2) を x→y で評価する関数を作る（CSS easing と同じ Newton 法）。
 */
function makeCubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const sampleDX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  const solveX = (x: number) => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(s) - x;
      if (Math.abs(dx) < 1e-6) return s;
      const d = sampleDX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= dx / d;
    }
    // Newton が収束しない場合の二分法フォールバック。
    let lo = 0;
    let hi = 1;
    s = x;
    for (let i = 0; i < 32; i++) {
      const xs = sampleX(s);
      if (Math.abs(xs - x) < 1e-6) break;
      if (x > xs) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solveX(t));
  };
}

/** declick フェードのイージング（0..1 → 0..1, slow in / fast out）。 */
export const fadeEase: (t: number) => number = makeCubicBezier(...FADE_BEZIER);

/** Web Audio setValueCurveAtTime 用のサンプル配列。descending=true で 1→0（out フェード）。 */
export function fadeCurveSamples(descending: boolean): Float32Array {
  const n = FADE_CURVE_SAMPLES;
  const arr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const e = fadeEase(i / (n - 1));
    arr[i] = descending ? 1 - e : e;
  }
  return arr;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
