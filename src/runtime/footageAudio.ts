// §11.4 / §11.5 — audio / video 内蔵音声の共有 gain ヘルパー（純関数）。
// 全経路（preview clock / export mux / bundle / DomRenderer）が同じ sampleGain を使い INV-2 を保つ。
// Web Audio に依存しない（scheduleGainAutomation は AudioParam を受け取るのみ）ため単体テスト可能。

import type { AnimatedProp, Frame, SceneObject, TimelineComposition } from "../core/schema";
import { staticProp } from "../core/props";
import { sampleScalar } from "./interpolate";

/** footage 音声 mix 対象（audio コンポーネント or 内蔵音声付き video コンポーネント）の純データ。 */
export interface FootageAudioSource {
  objectId: string;
  obj: SceneObject;
  assetId: string;
  inPoint: Frame;
  outPoint: Frame;
  /** 現状どおり plain number 読み取り（animated trimStart は既存未対応・本タスク非変更）。 */
  trimStart: Frame;
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

/**
 * timeline から音声 mix 対象レイヤー（enabled な audio / video）を列挙する純関数。
 * gainProp は readGainProp で正規化済み。trimStart は現状どおり plain number 読み取り。
 */
export function collectFootageAudioSources(comp: TimelineComposition): FootageAudioSource[] {
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
        inPoint: obj.inPoint,
        outPoint: obj.outPoint,
        trimStart: typeof rawTrim === "number" ? rawTrim : 0,
        gainProp: readGainProp(cmp.props["gain"]),
        componentType,
      });
    }
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
