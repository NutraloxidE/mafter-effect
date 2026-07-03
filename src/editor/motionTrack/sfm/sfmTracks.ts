/**
 * 長寿命特徴トラックのテーブルとキーフレーム選択（純関数）。
 * frame はすべて「抽出フレーム列のインデックス」（comp フレームではない）。
 */

import { median } from "./sfmCore";

export interface SfmObservation {
  frame: number;
  x: number;
  y: number;
}

export interface SfmTrack {
  id: number;
  /** frame 昇順 */
  obs: SfmObservation[];
}

export interface TrackTable {
  tracks: SfmTrack[];
  frameCount: number;
  /** frame → その frame を観測するトラックの (trackIdx, obsIdx) */
  frameIndex: Array<Array<{ trackIdx: number; obsIdx: number }>>;
}

export interface FramePoints {
  points: Array<{ id: number; x: number; y: number }>;
}

/** worker が蓄積した per-frame 観測からトラックテーブルを構築。 */
export function buildTrackTable(frames: FramePoints[], minTrackLen = 2): TrackTable {
  const byId = new Map<number, SfmObservation[]>();
  for (let f = 0; f < frames.length; f++) {
    for (const p of frames[f]!.points) {
      let list = byId.get(p.id);
      if (!list) {
        list = [];
        byId.set(p.id, list);
      }
      list.push({ frame: f, x: p.x, y: p.y });
    }
  }
  const tracks: SfmTrack[] = [];
  for (const [id, obs] of byId) {
    if (obs.length < minTrackLen) continue;
    obs.sort((a, b) => a.frame - b.frame);
    // 同一トラックが同一フレームに複数回出るのは不正 → 最初を残す
    const dedup: SfmObservation[] = [];
    for (const o of obs) {
      if (dedup.length === 0 || dedup[dedup.length - 1]!.frame !== o.frame) dedup.push(o);
    }
    if (dedup.length < minTrackLen) continue;
    tracks.push({ id, obs: dedup });
  }
  tracks.sort((a, b) => a.id - b.id);

  const frameIndex: TrackTable["frameIndex"] = Array.from(
    { length: frames.length },
    () => [],
  );
  for (let ti = 0; ti < tracks.length; ti++) {
    const t = tracks[ti]!;
    for (let oi = 0; oi < t.obs.length; oi++) {
      const f = t.obs[oi]!.frame;
      if (f >= 0 && f < frames.length) frameIndex[f]!.push({ trackIdx: ti, obsIdx: oi });
    }
  }
  return { tracks, frameCount: frames.length, frameIndex };
}

/** 2 フレーム間の共通トラック（両方に観測があるもの）。 */
export function commonTrackPairs(
  table: TrackTable,
  f0: number,
  f1: number,
): Array<{ trackIdx: number; x0: number; y0: number; x1: number; y1: number }> {
  const at1 = new Map<number, { x: number; y: number }>();
  for (const e of table.frameIndex[f1] ?? []) {
    const o = table.tracks[e.trackIdx]!.obs[e.obsIdx]!;
    at1.set(e.trackIdx, { x: o.x, y: o.y });
  }
  const out: Array<{ trackIdx: number; x0: number; y0: number; x1: number; y1: number }> = [];
  for (const e of table.frameIndex[f0] ?? []) {
    const p1 = at1.get(e.trackIdx);
    if (!p1) continue;
    const o0 = table.tracks[e.trackIdx]!.obs[e.obsIdx]!;
    out.push({ trackIdx: e.trackIdx, x0: o0.x, y0: o0.y, x1: p1.x, y1: p1.y });
  }
  return out;
}

export interface KeyframeSelectOptions {
  /** 新規 KF を切る median flow 閾値（px） */
  minFlowPx: number;
  /** 前 KF との共通トラック数がこの割合を下回ったら KF */
  minCommonRatio: number;
  /** KF 間の最大間隔（フレーム数） */
  maxGap: number;
  /** KF 総数上限（超えたら間引き） */
  maxKeyframes: number;
}

export const DEFAULT_KF_OPTIONS: KeyframeSelectOptions = {
  minFlowPx: 18,
  minCommonRatio: 0.55,
  maxGap: 30,
  maxKeyframes: 80,
};

/** 視差・トラック生存率ベースのキーフレーム選択。 */
export function selectKeyframes(
  table: TrackTable,
  opts: Partial<KeyframeSelectOptions> = {},
): number[] {
  const o = { ...DEFAULT_KF_OPTIONS, ...opts };
  const n = table.frameCount;
  if (n === 0) return [];
  const kfs: number[] = [0];
  let lastKf = 0;
  let lastKfTrackCount = (table.frameIndex[0] ?? []).length;
  for (let f = 1; f < n; f++) {
    const common = commonTrackPairs(table, lastKf, f);
    const flow = median(common.map((c) => Math.hypot(c.x1 - c.x0, c.y1 - c.y0)));
    const commonRatio = lastKfTrackCount > 0 ? common.length / lastKfTrackCount : 0;
    const gap = f - lastKf;
    if (
      gap >= o.maxGap ||
      (Number.isFinite(flow) && flow >= o.minFlowPx) ||
      commonRatio < o.minCommonRatio
    ) {
      kfs.push(f);
      lastKf = f;
      lastKfTrackCount = (table.frameIndex[f] ?? []).length;
    }
  }
  const last = n - 1;
  if (kfs[kfs.length - 1] !== last && last > 0) kfs.push(last);

  if (kfs.length > o.maxKeyframes) {
    const stride = kfs.length / o.maxKeyframes;
    const thinned: number[] = [];
    for (let i = 0; i < o.maxKeyframes; i++) {
      thinned.push(kfs[Math.min(kfs.length - 1, Math.round(i * stride))]!);
    }
    if (thinned[thinned.length - 1] !== last) thinned.push(last);
    return [...new Set(thinned)].sort((a, b) => a - b);
  }
  return kfs;
}
