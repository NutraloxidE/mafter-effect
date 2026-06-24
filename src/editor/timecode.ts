/**
 * Duration 等の表示・入力用タイムコード変換（純関数・§5.6）。
 * 内部値は INV-5 どおり整数 Frame のまま。見た目だけ AE 既定の
 * ノンドロップ `H:MM:SS:FF`（コロン区切り）に変換する。
 */

const p2 = (n: number): string => String(n).padStart(2, "0");

const safeFps = (fps: number): number => Math.max(1, Math.round(fps));

/** 整数 frame → `H:MM:SS:FF`。`H` は非ゼロ詰め、`MM`/`SS`/`FF` は 2 桁ゼロ詰め。 */
export function framesToTimecode(frames: number, fps: number): string {
  const f = Math.max(0, Math.round(frames));
  const sfps = safeFps(fps);
  const totalSec = Math.floor(f / sfps);
  const ff = f % sfps;
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  return `${hh}:${p2(mm)}:${p2(ss)}:${p2(ff)}`;
}

/**
 * `H:MM:SS:FF`（`:` / `;` 区切り）→ 整数 frame。右詰め解釈:
 * 4 seg=`H:MM:SS:FF` / 3=`MM:SS:FF` / 2=`SS:FF` / 1=生フレーム数。
 * 桁あふれは自然に繰り上がる。負数・非数値・空は `null`。
 */
export function parseTimecode(text: string, fps: number): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parts = trimmed.split(/[:;]/).map((p) => p.trim());
  if (parts.length > 4) return null;
  if (parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map((p) => parseInt(p, 10));
  // 右詰め: 末尾を FF とし、左へ SS / MM / H と割り当てる。
  const at = (fromRight: number): number => nums[nums.length - 1 - fromRight] ?? 0;
  const ff = at(0);
  const ss = at(1);
  const mm = at(2);
  const hh = at(3);
  return ((hh * 60 + mm) * 60 + ss) * safeFps(fps) + ff;
}
