// フィードバックループ: シグナル収集 + 送信（doc/feedback-loop.md §Phase2b）。
// resolve() から一切参照されない、エディタ運用データ専用モジュール（INV-1 非干渉）。
// §5 / INV への影響なし（project.json を汚染しない）。

import { ulid } from "ulid";
import {
  BurstTracker,
  computeFrustrationScore,
  createFrustrationState,
  FRUSTRATION_THRESHOLD,
  KeyedBurstTracker,
  recordEvent,
  ReversalTracker,
  type FrustrationState,
  type SignalType,
} from "./feedbackSignals";

const SESSION_ID_KEY = "mafter:feedbackSessionId";
const PROMPT_COUNT_KEY = "mafter:feedbackPromptCount";
const COOLDOWN_UNTIL_KEY = "mafter:feedbackCooldownUntil";
const OPT_OUT_KEY = "mafter:feedbackOptOut";
const RETRY_QUEUE_KEY = "mafter:feedbackRetryQueue";

const UNDO_BURST_WINDOW_MS = 10_000;
const UNDO_BURST_MIN_COUNT = 3;
const REDO_AFTER_UNDO_WINDOW_MS = 15_000;
const SCRUB_OSCILLATION_WINDOW_MS = 2_000;
const SCRUB_OSCILLATION_MIN_COUNT = 4;
const INSPECTOR_TWEAK_WINDOW_MS = 30_000;
const INSPECTOR_TWEAK_MIN_COUNT = 6;

const COOLDOWN_MS = 30 * 60 * 1000;
const MAX_PROMPTS_PER_SESSION = 2;

const MAX_MESSAGE_LENGTH = 4000;
const MAX_RETRY_QUEUE_SIZE = 20;

export interface FeedbackPayload {
  schemaVersion: 1;
  id: string;
  ts: string;
  sessionId: string;
  signals: string[];
  message?: string;
  appVersion: string;
  userAgent: string;
  host: string;
}

function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getSessionId(): string {
  const storage = safeSessionStorage();
  if (!storage) return "no-session-storage";
  try {
    let id = storage.getItem(SESSION_ID_KEY);
    if (!id) {
      id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : ulid();
      storage.setItem(SESSION_ID_KEY, id);
    }
    return id;
  } catch {
    return "no-session-storage";
  }
}

function getAppVersion(): string {
  try {
    // vite.config.ts の define で注入（Phase2b）。未注入環境（vitest 等）ではフォールバック。
    return typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

declare const __APP_VERSION__: string;

// G27: トークン無し = feedback UI 非表示（サーバも 404/401 で拒否）。
// VITE_ プレフィックスによりクライアントに焼き込まれるのは仕様（漏洩許容・秘密鍵ではない。.env.example 参照）。
const FEEDBACK_TOKEN: string | undefined =
  typeof import.meta !== "undefined" ? (import.meta.env?.VITE_FEEDBACK_TOKEN as string | undefined) : undefined;

/** feedback 機能が有効か（ビルド時にトークンが注入されているか）。UI 表示条件に使う。 */
export function isFeedbackEnabled(): boolean {
  return !!FEEDBACK_TOKEN;
}

/**
 * 「不便シグナル」の収集・スコアリング・催促可否判定・送信を担うシングルトン。
 * DOM/Date.now を直接使うが resolve() からは参照されない（INV-1 対象外）。
 */
class FeedbackCollector {
  private state: FrustrationState = createFrustrationState();
  private readonly undoBurstTracker = new BurstTracker(UNDO_BURST_WINDOW_MS, UNDO_BURST_MIN_COUNT);
  private readonly scrubReversalTracker = new ReversalTracker(SCRUB_OSCILLATION_WINDOW_MS, SCRUB_OSCILLATION_MIN_COUNT);
  private readonly inspectorTweakTracker = new KeyedBurstTracker(INSPECTOR_TWEAK_WINDOW_MS, INSPECTOR_TWEAK_MIN_COUNT);
  private lastUndoBurstAt: number | null = null;
  private readonly listeners = new Set<() => void>();

  private record(type: SignalType, now: number): void {
    this.state = recordEvent(this.state, type, now);
    this.notify();
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  /** UI（FeedbackPrompt）が催促条件の変化を検知するための購読。 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onUndo(now: number = Date.now()): void {
    if (this.undoBurstTracker.push(now)) {
      this.lastUndoBurstAt = now;
      this.record("undo_burst", now);
    }
  }

  onRedo(now: number = Date.now()): void {
    if (this.lastUndoBurstAt !== null && now - this.lastUndoBurstAt <= REDO_AFTER_UNDO_WINDOW_MS) {
      this.record("redo_after_undo", now);
    }
  }

  onExportError(now: number = Date.now()): void {
    this.record("export_error", now);
  }

  onExportCancelled(now: number = Date.now()): void {
    this.record("export_cancelled", now);
  }

  onExportFallback(now: number = Date.now()): void {
    this.record("export_fallback", now);
  }

  onZipError(now: number = Date.now()): void {
    this.record("zip_error", now);
  }

  onProxyFailed(now: number = Date.now()): void {
    this.record("proxy_failed", now);
  }

  /** TimelinePanel ruler scrub 用。フレーム移動量（delta）を渡す。 */
  onScrubFrame(delta: number, now: number = Date.now()): void {
    if (this.scrubReversalTracker.pushDelta(delta, now)) {
      this.record("scrub_oscillation", now);
    }
  }

  /** InspectorPanel の param 確定用。key は objectId+prop 識別子（例: `${objId}:opacity`）。 */
  onInspectorTweak(key: string, now: number = Date.now()): void {
    if (this.inspectorTweakTracker.push(key, now)) {
      this.record("rapid_inspector_tweak", now);
    }
  }

  getScore(now: number = Date.now()): number {
    return computeFrustrationScore(this.state, now);
  }

  getTriggeredSignalLabels(): SignalType[] {
    return [...new Set(this.state.events.map((e) => e.type))];
  }

  private getPromptCount(): number {
    const storage = safeSessionStorage();
    if (!storage) return 0;
    try {
      return Number(storage.getItem(PROMPT_COUNT_KEY) ?? "0") || 0;
    } catch {
      return 0;
    }
  }

  private incrementPromptCount(): void {
    const storage = safeSessionStorage();
    if (!storage) return;
    try {
      storage.setItem(PROMPT_COUNT_KEY, String(this.getPromptCount() + 1));
    } catch {
      /* ignore */
    }
  }

  private isInCooldown(now: number): boolean {
    const storage = safeSessionStorage();
    if (!storage) return false;
    try {
      const until = Number(storage.getItem(COOLDOWN_UNTIL_KEY) ?? "0");
      return now < until;
    } catch {
      return false;
    }
  }

  private setCooldownUntil(until: number): void {
    const storage = safeSessionStorage();
    if (!storage) return;
    try {
      storage.setItem(COOLDOWN_UNTIL_KEY, String(until));
    } catch {
      /* ignore */
    }
  }

  isOptedOut(): boolean {
    const storage = safeLocalStorage();
    if (!storage) return false;
    try {
      return storage.getItem(OPT_OUT_KEY) === "1";
    } catch {
      return false;
    }
  }

  setOptedOut(optedOut: boolean): void {
    const storage = safeLocalStorage();
    if (!storage) return;
    try {
      if (optedOut) storage.setItem(OPT_OUT_KEY, "1");
      else storage.removeItem(OPT_OUT_KEY);
    } catch {
      /* ignore */
    }
    this.notify();
  }

  /** G10: 閾値30・クールダウン30分・セッション最大2回。G27: トークン未注入ビルドでは常に false。 */
  shouldPrompt(now: number = Date.now()): boolean {
    if (!isFeedbackEnabled()) return false;
    if (this.isOptedOut()) return false;
    if (this.getScore(now) < FRUSTRATION_THRESHOLD) return false;
    if (this.getPromptCount() >= MAX_PROMPTS_PER_SESSION) return false;
    if (this.isInCooldown(now)) return false;
    return true;
  }

  markPrompted(now: number = Date.now()): void {
    this.incrementPromptCount();
    this.setCooldownUntil(now + COOLDOWN_MS);
  }

  buildPayload(message?: string): FeedbackPayload {
    const trimmed = message?.slice(0, MAX_MESSAGE_LENGTH);
    return {
      schemaVersion: 1,
      id: ulid(),
      ts: new Date().toISOString(),
      sessionId: getSessionId(),
      signals: this.getTriggeredSignalLabels(),
      message: trimmed,
      appVersion: getAppVersion(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
      host: typeof location !== "undefined" ? location.hostname : "unknown",
    };
  }
}

export const feedbackCollector = new FeedbackCollector();

function readRetryQueue(): FeedbackPayload[] {
  const storage = safeLocalStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(RETRY_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as FeedbackPayload[]) : [];
  } catch {
    return [];
  }
}

function writeRetryQueue(queue: FeedbackPayload[]): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(RETRY_QUEUE_KEY, JSON.stringify(queue.slice(-MAX_RETRY_QUEUE_SIZE)));
  } catch {
    /* ignore */
  }
}

async function postPayload(payload: FeedbackPayload): Promise<boolean> {
  if (!FEEDBACK_TOKEN) return false;
  // Electron ラッパーは file:// / dev-server 由来で API とオリジンが異なるため、
  // レンダラから直接 fetch すると Authorization ヘッダ付き CORS プリフライトで弾かれる。
  // メインプロセス経由の IPC で送信することで回避する（electron/main.ts の feedback:post）。
  if (typeof window !== "undefined" && window.mafterDesktop?.isElectron) {
    try {
      return await window.mafterDesktop.postFeedback(payload);
    } catch {
      return false;
    }
  }
  try {
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FEEDBACK_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * フィードバックを送信する。失敗時は localStorage キューに退避し次回呼び出し時にリトライする。
 * 手動送信（ProjectPanel ボタン）・催促モーダル送信の双方から呼ぶ。
 */
export async function submitFeedback(message?: string): Promise<boolean> {
  const payload = feedbackCollector.buildPayload(message);

  // 前回までの失敗分を先にリトライ（成否に関わらず今回分の送信は必ず試みる）。
  const queued = readRetryQueue();
  const stillFailed: FeedbackPayload[] = [];
  for (const p of queued) {
    if (!(await postPayload(p))) stillFailed.push(p);
  }

  const ok = await postPayload(payload);
  writeRetryQueue(ok ? stillFailed : [...stillFailed, payload]);
  return ok;
}
