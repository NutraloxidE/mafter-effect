// §33 リーダーキーのダブルタップ判定（純関数・テスト可能）。

/** ダブルタップと見なす最大間隔（ms）。 */
export const DOUBLE_TAP_WINDOW_MS = 400;

/**
 * 直近タップ時刻 lastTapMs（0 = なし）と今回タップ時刻 nowMs から、
 * 「2 回目のタップ（＝ダブルタップ成立）」かどうかを返す。
 */
export function isSecondTap(
  lastTapMs: number,
  nowMs: number,
  windowMs: number = DOUBLE_TAP_WINDOW_MS,
): boolean {
  return lastTapMs > 0 && nowMs - lastTapMs <= windowMs;
}
