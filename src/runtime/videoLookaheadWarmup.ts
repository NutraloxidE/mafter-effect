// §11.4 — preview / bundle 再生中の「異なるアセット間カット境界」先読み warm-up 判定（純関数・DOM 非依存）。
// 入場 in 点が近い video クリップを列挙し、DomRenderer が offscreen <video> をプールへ先行投入する。

import type { Frame, TimelineComposition } from "../core/schema";

/** 先読み判定に使う video クリップの最小情報。 */
export interface VideoClipLookaheadInput {
  objectId: string;
  assetId: string;
  inPoint: Frame;
  outPoint: Frame;
  trimStart: Frame;
  enabled: boolean;
  /** §11.4b 画質ティア（省略 = original）。 */
  footageQuality?: string;
}

/** 先読み warm-up すべきクリップ（in 点のソース trim 時刻付き）。 */
export interface VideoLookaheadTarget {
  objectId: string;
  assetId: string;
  /** in 点でのソース時刻（秒）= trimStart / fps。 */
  targetSec: number;
  inPoint: Frame;
}

export interface VideoLookaheadOptions {
  /** 先読み窓（フレーム）。省略時は fps（≈1 秒）。 */
  lookaheadFrames?: number;
  /** 現フレームで表示中の video assetId。同一アセット連結カットはプール再利用で足りるため除外。 */
  activeAssetIds?: ReadonlySet<string>;
}

const DEFAULT_LOOKAHEAD_SEC = 1;

/**
 * 現在フレームから先読み窓内に in 点がある enabled video クリップを返す。
 * 既に表示中（currentFrame >= inPoint）・窓外・activeAssetIds と同一 asset は除外。
 */
export function computeVideoLookaheadWarmupTargets(
  currentFrame: Frame,
  fps: number,
  clips: readonly VideoClipLookaheadInput[],
  options?: VideoLookaheadOptions,
): VideoLookaheadTarget[] {
  const safeFps = Math.max(1, fps);
  const lookahead =
    options?.lookaheadFrames ?? Math.max(1, Math.round(safeFps * DEFAULT_LOOKAHEAD_SEC));
  const active = options?.activeAssetIds;
  const out: VideoLookaheadTarget[] = [];

  for (const clip of clips) {
    if (!clip.enabled) continue;
    if (currentFrame >= clip.inPoint) continue;
    const framesUntilIn = clip.inPoint - currentFrame;
    if (framesUntilIn > lookahead) continue;
    if (active?.has(clip.assetId)) continue;

    out.push({
      objectId: clip.objectId,
      assetId: clip.assetId,
      targetSec: Math.max(0, clip.trimStart / safeFps),
      inPoint: clip.inPoint,
    });
  }

  out.sort((a, b) => a.inPoint - b.inPoint || a.objectId.localeCompare(b.objectId));
  return out;
}

/** 編集中 comp から video クリップ一覧を抽出（PreviewPanel / BundlePlayer 向け）。 */
export function collectVideoClipsFromComp(comp: TimelineComposition): VideoClipLookaheadInput[] {
  const clips: VideoClipLookaheadInput[] = [];
  for (const obj of comp.objects) {
    if (!obj.enabled) continue;
    const videoComp = obj.components.find((c) => c.type === "video");
    if (!videoComp) continue;
    const assetId = videoComp.props["asset"];
    if (typeof assetId !== "string" || assetId === "") continue;
    clips.push({
      objectId: obj.id,
      assetId,
      inPoint: obj.inPoint,
      outPoint: obj.outPoint,
      trimStart: (videoComp.props["trimStart"] as number | undefined) ?? 0,
      enabled: obj.enabled,
      footageQuality: videoComp.props["footageQuality"] as string | undefined,
    });
  }
  return clips;
}
