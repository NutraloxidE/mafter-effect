/**
 * BPM 併記表示用の Bar.Beat 変換（純関数・編集補助・§21.1b）。
 * 正準時間は INV-5 どおり整数 Frame。bpm/beatsPerBar は表示専用メタで resolve 非参照。
 */
import { framesToTimecode } from "./timecode";

const DEFAULT_BEATS_PER_BAR = 4;
// 拍境界の浮動小数誤差で beat が手前にずれるのを防ぐ微小マージン
// （例: frame 60 = 拍 4.0 が 3.9999… になって "1.4" 化けするのを防ぎ "2.1" を保証）。
const BEAT_EPS = 1e-6;

const safeFps = (fps: number): number => Math.max(1, Math.round(fps));

/**
 * frame → `Bar.Beat`（ともに 1 始まり）。bpm が正でなければ `null`（UI 側で併記を省く）。
 * 例: 120 BPM @ 30fps → frame 0 = "1.1"、frame 15 = "1.2"、frame 60 = "2.1"。
 */
export function formatBarBeat(
  frame: number,
  fps: number,
  bpm: number,
  beatsPerBar: number = DEFAULT_BEATS_PER_BAR,
): string | null {
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  const f = safeFps(fps);
  const bpb = Math.max(1, Math.round(beatsPerBar));
  const totalBeats = (Math.max(0, frame) / f) * (bpm / 60) + BEAT_EPS;
  const bar = Math.floor(totalBeats / bpb) + 1;
  const beat = Math.floor(totalBeats % bpb) + 1;
  return `${bar}.${beat}`;
}

/**
 * タイムコード（必ず表示）＋ bpm 有効時のみ ` · Bar.Beat` を併記する共有ヘルパー。
 * bpm 無効（undefined / 0 / 非正）なら従来どおりタイムコードのみ。
 */
export function formatTimeWithBeat(
  frame: number,
  fps: number,
  bpm: number | undefined,
  beatsPerBar?: number,
): string {
  const tc = framesToTimecode(frame, fps);
  const bb = bpm !== undefined ? formatBarBeat(frame, fps, bpm, beatsPerBar) : null;
  return bb ? `${tc} · ${bb}` : tc;
}
