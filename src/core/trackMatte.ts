import type { ObjectId, SceneObject, TrackMatteMode } from "./schema";
import { TRACK_MATTE_MODES } from "./schema";

/** §5.4f: 許可された trackMatteMode か。 */
export function isKnownTrackMatteMode(v: string): v is TrackMatteMode {
  return (TRACK_MATTE_MODES as readonly string[]).includes(v);
}

/** マット源・塗りに使えないレイヤー（調整 / Null / camera のみ）。 */
export function isTrackMatteIneligible(obj: SceneObject): boolean {
  if (obj.isAdjustment === true) return true;
  if (obj.isNull === true) return true;
  if (obj.components.length === 0) return true;
  if (obj.components.every((c) => c.type === "camera")) return true;
  return false;
}

export interface TrackMattePair {
  fillId: ObjectId;
  matteId: ObjectId;
  mode: TrackMatteMode;
}

/**
 * スタック（zOrder 昇順・タイは id）で直上をマット源とする。
 * フレーム非依存・enabled 非依存（非可視時は空マット。再バインドしない）。
 */
export function resolveTrackMattePairs(objects: readonly SceneObject[]): TrackMattePair[] {
  const stack = objects
    .slice()
    .sort((a, b) =>
      a.zOrder !== b.zOrder ? a.zOrder - b.zOrder : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );

  const pairs: TrackMattePair[] = [];
  const usedAsMatte = new Set<ObjectId>();

  for (let i = 0; i < stack.length; i++) {
    const fill = stack[i]!;
    const mode = fill.trackMatteMode;
    if (mode === undefined || !isKnownTrackMatteMode(mode)) continue;
    if (isTrackMatteIneligible(fill)) continue;
    // 既に他の塗りのマット源になっているレイヤーの trackMatteMode は無視（連鎖なし）。
    if (usedAsMatte.has(fill.id)) continue;

    // 直上 = 次の適格レイヤー（ineligible はスキップしてさらに上を見ない — AE の「直上1枚」に合わせる）
    const matte = stack[i + 1];
    if (!matte) continue;
    if (isTrackMatteIneligible(matte)) continue;
    if (usedAsMatte.has(matte.id)) continue;

    pairs.push({ fillId: fill.id, matteId: matte.id, mode });
    usedAsMatte.add(matte.id);
  }

  return pairs;
}

export function trackMatteMaskId(fillId: ObjectId): string {
  return `tm-${fillId}`;
}

export function isLumaTrackMatte(mode: TrackMatteMode): boolean {
  return mode === "luma" || mode === "lumaInverted";
}

export function isInvertedTrackMatte(mode: TrackMatteMode): boolean {
  return mode === "alphaInverted" || mode === "lumaInverted";
}
