// フィードバックループ: 「不便シグナル」のスコアリング（純関数・INV-1 非干渉）。
// resolve(comp, frame) からは一切参照されない、エディタ運用データ専用のモジュール。
// doc/feedback-loop.md §Phase2a も参照。

export type SignalType =
  | "undo_burst"
  | "redo_after_undo"
  | "export_error"
  | "export_cancelled"
  | "export_fallback"
  | "zip_error"
  | "proxy_failed"
  | "scrub_oscillation"
  | "rapid_inspector_tweak";

export const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  undo_burst: 12,
  redo_after_undo: 4,
  export_error: 25,
  export_cancelled: 8,
  export_fallback: 12,
  zip_error: 20,
  proxy_failed: 15,
  scrub_oscillation: 10,
  rapid_inspector_tweak: 8,
};

export const FRUSTRATION_THRESHOLD = 30;

export interface RecordedEvent {
  type: SignalType;
  ts: number;
}

export interface FrustrationState {
  events: RecordedEvent[];
}

export function createFrustrationState(): FrustrationState {
  return { events: [] };
}

/** 古いイベントは指数減衰で薄れる（誤爆抑制）。半減期 5 分。 */
const DECAY_HALF_LIFE_MS = 5 * 60 * 1000;
/** スコア計算の観測窓。これより古いイベントは無視。 */
const SCORE_WINDOW_MS = 30 * 60 * 1000;

export function recordEvent(state: FrustrationState, type: SignalType, now: number): FrustrationState {
  return { events: [...state.events, { type, ts: now }] };
}

/** 0–100 のフラストレーションスコア。窓外・未来イベントは無視。 */
export function computeFrustrationScore(
  state: FrustrationState,
  now: number,
  windowMs: number = SCORE_WINDOW_MS,
): number {
  let score = 0;
  for (const e of state.events) {
    const age = now - e.ts;
    if (age < 0 || age > windowMs) continue;
    const decay = Math.pow(0.5, age / DECAY_HALF_LIFE_MS);
    score += SIGNAL_WEIGHTS[e.type] * decay;
  }
  return Math.min(100, Math.round(score));
}

/**
 * 一定時間内に一定回数以上発生したら一度だけ true を返す（edge-triggered）バーストトラッカー。
 * `now` は呼び出し側が渡す（Date.now 依存を外に出しテスト可能にする）。
 */
export class BurstTracker {
  private timestamps: number[] = [];

  constructor(private readonly windowMs: number, private readonly minCount: number) {}

  /** 新規発生を1件記録。閾値をまたいだ瞬間だけ true。 */
  push(now: number): boolean {
    this.timestamps = this.timestamps.filter((t) => now - t <= this.windowMs);
    const wasBurst = this.timestamps.length >= this.minCount;
    this.timestamps.push(now);
    const isBurstNow = this.timestamps.length >= this.minCount;
    return !wasBurst && isBurstNow;
  }
}

/** キーごとに独立した BurstTracker を保持する（例: objectId+prop 単位の rapid tweak 検知）。 */
export class KeyedBurstTracker {
  private readonly trackers = new Map<string, BurstTracker>();

  constructor(private readonly windowMs: number, private readonly minCount: number) {}

  push(key: string, now: number): boolean {
    let tracker = this.trackers.get(key);
    if (!tracker) {
      tracker = new BurstTracker(this.windowMs, this.minCount);
      this.trackers.set(key, tracker);
    }
    return tracker.push(now);
  }
}

/**
 * フレーム方向の反転（scrub oscillation）を検知する。
 * 直前と逆方向の delta が来るたびに「反転」を1件記録し、窓内で閾値に達した瞬間だけ true。
 */
export class ReversalTracker {
  private lastDirection: -1 | 0 | 1 = 0;
  private reversalTimestamps: number[] = [];

  constructor(private readonly windowMs: number, private readonly minCount: number) {}

  pushDelta(delta: number, now: number): boolean {
    if (delta === 0) return false;
    const dir: -1 | 1 = delta > 0 ? 1 : -1;
    const reversed = this.lastDirection !== 0 && dir !== this.lastDirection;
    this.lastDirection = dir;
    if (!reversed) return false;

    this.reversalTimestamps = this.reversalTimestamps.filter((t) => now - t <= this.windowMs);
    const wasBurst = this.reversalTimestamps.length >= this.minCount;
    this.reversalTimestamps.push(now);
    const isBurstNow = this.reversalTimestamps.length >= this.minCount;
    return !wasBurst && isBurstNow;
  }
}
