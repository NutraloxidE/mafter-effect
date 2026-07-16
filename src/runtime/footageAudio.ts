// §11.4 / §11.5 — audio / video 内蔵音声の共有 gain ヘルパー（純関数）。
// 全経路（preview clock / export mux / bundle / DomRenderer）が同じ sampleGain を使い INV-2 を保つ。
// Web Audio に依存しない（scheduleGainAutomation は AudioParam を受け取るのみ）ため単体テスト可能。

import type { AnimatedProp, Frame, SceneObject, TimelineComposition } from "../core/schema";
import { staticProp } from "../core/props";
import { sampleScalar } from "./interpolate";
import { isCompNestDepthAllowed } from "./compLayer";

/** footage 音声 mix 対象（audio コンポーネント or 内蔵音声付き video コンポーネント）の純データ。 */
export interface FootageAudioSource {
  objectId: string;
  obj: SceneObject;
  assetId: string;
  inPoint: Frame;
  outPoint: Frame;
  /**
   * **ルート comp の fps 単位**へ換算済み（消費側は一律 `trimStart / rootFps` で media 秒を得る）。
   * fps の異なるネスト由来では非整数になりうる（媒体内オフセットであり timeline frame ではない）。
   * 現状どおり plain number 読み取り（animated trimStart は既存未対応）。
   */
  trimStart: number;
  gainProp: AnimatedProp<number>;
  componentType: "audio" | "video";
}

function isAnimatedProp(v: unknown): v is AnimatedProp<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    "value" in v &&
    "keyframes" in v &&
    Array.isArray((v as AnimatedProp<unknown>).keyframes)
  );
}

/**
 * 任意の raw 値（plain number / AnimatedProp / 欠落）を `AnimatedProp<number>` に正規化する。
 * - AnimatedProp<number> → そのまま（value が number のときのみ）
 * - plain number → staticProp(number)（後方互換）
 * - 欠落・非数値 → staticProp(1)（既定音量）
 */
export function readGainProp(raw: unknown): AnimatedProp<number> {
  if (isAnimatedProp(raw) && typeof (raw as AnimatedProp<unknown>).value === "number") {
    return raw as AnimatedProp<number>;
  }
  if (typeof raw === "number") {
    return staticProp(raw);
  }
  return staticProp(1);
}

/** frame における gain を 0..1 に clamp して返す（全再生経路が共有する正準サンプラ）。 */
export function sampleGain(raw: unknown, frame: Frame): number {
  const v = sampleScalar(readGainProp(raw), frame);
  return Math.max(0, Math.min(1, v));
}

/** nested comp の frame（自身の comp 上の単位）をルート comp の frame 単位へ写像する関数。 */
type FrameMapper = (frame: Frame) => Frame;

const identityFrameMapper: FrameMapper = (f) => f;

/** gainProp の keyframe.frame をルート frame 空間へ写像した複製を返す（value/easing は不変）。 */
function remapGainProp(prop: AnimatedProp<number>, toRoot: FrameMapper): AnimatedProp<number> {
  if (prop.keyframes.length === 0) return prop;
  return { ...prop, keyframes: prop.keyframes.map((k) => ({ ...k, frame: toRoot(k.frame) })) };
}

/**
 * timeline から音声 mix 対象レイヤー（enabled な audio / video）を列挙する純関数。
 * gainProp は readGainProp で正規化済み。trimStart は現状どおり plain number 読み取り。
 *
 * resolveComp を渡すと、ネストされた `comp` コンポーネント（precomp）の中身も再帰的に集める
 * （§23）。inPoint/outPoint/gainProp の keyframe.frame はすべて **ルート comp の frame 単位**へ
 * 写像済みで返す — 呼び出し側（PreviewAudioClock.schedule 等）はネストの有無を意識せず
 * `(rootFrame - source.inPoint) / rootFps` のような既存の単純な式をそのまま使える。
 * fps の異なるネストは compChildFrame と同じ秒ベース換算（§23.2）。trimStart も同様に
 * ルート fps 単位へ換算して返す（子 comp の fps のまま返すと、消費側の `trimStart / rootFps` が
 * fps 比の分だけ誤った media 位置から再生してしまう）。
 * resolveComp 省略時はトップレベルのみ（既存呼び出し元との後方互換）。
 */
export function collectFootageAudioSources(
  comp: TimelineComposition,
  resolveComp?: (compId: string) => TimelineComposition | undefined,
): FootageAudioSource[] {
  return collectFootageAudioSourcesRec(comp, resolveComp, identityFrameMapper, 0, comp.fps, comp.fps);
}

function collectFootageAudioSourcesRec(
  comp: TimelineComposition,
  resolveComp: ((compId: string) => TimelineComposition | undefined) | undefined,
  toRoot: FrameMapper,
  depth: number,
  rootFps: number,
  ownFps: number,
): FootageAudioSource[] {
  if (!isCompNestDepthAllowed(depth)) return [];
  const sources: FootageAudioSource[] = [];
  for (const obj of comp.objects) {
    if (!obj.enabled) continue;
    for (const componentType of ["audio", "video"] as const) {
      const cmp = obj.components.find((c) => c.type === componentType);
      if (!cmp) continue;
      const assetId = cmp.props["asset"];
      if (typeof assetId !== "string" || assetId === "") continue;
      const rawTrim = cmp.props["trimStart"];
      sources.push({
        objectId: obj.id,
        obj,
        assetId,
        inPoint: toRoot(obj.inPoint),
        outPoint: toRoot(obj.outPoint),
        trimStart: (typeof rawTrim === "number" ? rawTrim : 0) * (rootFps / ownFps),
        gainProp: remapGainProp(readGainProp(cmp.props["gain"]), toRoot),
        componentType,
      });
    }
    if (!resolveComp) continue;
    const compCmp = obj.components.find((c) => c.type === "comp");
    if (!compCmp) continue;
    const nestedCompId = compCmp.props["compId"] as string | undefined;
    const nested = nestedCompId ? resolveComp(nestedCompId) : undefined;
    if (!nested) continue;
    const layerTrimStart = typeof compCmp.props["trimStart"] === "number" ? (compCmp.props["trimStart"] as number) : 0;
    const parentFps = comp.fps;
    const childFps = nested.fps;
    const layerInPoint = obj.inPoint;
    // §23.2 と同じ秒ベース換算の逆写像: nestedFrame → このレベルの frame → さらに親へ。
    const childToRoot: FrameMapper = (childFrame) =>
      toRoot(Math.round(layerInPoint + ((childFrame - layerTrimStart) * parentFps) / childFps));
    sources.push(...collectFootageAudioSourcesRec(nested, resolveComp, childToRoot, depth + 1, rootFps, childFps));
  }
  return sources;
}

export interface GainAutomationOptions {
  fps: number;
  /** export 範囲（comp frame）。[start, end) を 1/fps 刻みで automation する。 */
  exportStartFrame: number;
  exportEndFrame: number;
  /** offline context 上で frame=exportStartFrame が鳴り始める時刻（秒）。通常 0。 */
  mixStartSec?: number;
}

/**
 * export 用 gain automation を AudioParam に打つ。
 * KF 間 `linearRampToValueAtTime` は hold/bezier easing と一致しないため、
 * export 区間を 1/fps 刻みで `sampleScalar` 評価し setValueAtTime をフレーム境界ごとに打つ。
 * → preview / interpolate.ts と完全同一曲線になる（INV-2）。
 */
export function scheduleGainAutomation(
  param: { setValueAtTime: (value: number, startTime: number) => void; value: number },
  gainProp: AnimatedProp<number>,
  opts: GainAutomationOptions,
): void {
  const { fps, exportStartFrame, exportEndFrame, mixStartSec = 0 } = opts;
  // 初期値（ramp を避けるため frame=start の値を t=mixStartSec で確定）。
  param.value = clamp01(sampleScalar(gainProp, exportStartFrame));
  for (let f = exportStartFrame; f < exportEndFrame; f++) {
    const t = mixStartSec + (f - exportStartFrame) / fps;
    param.setValueAtTime(clamp01(sampleScalar(gainProp, f)), Math.max(0, t));
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
