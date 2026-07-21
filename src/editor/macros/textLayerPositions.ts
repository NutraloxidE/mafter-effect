// §32.1 reading モード用: 現フレームでの各レイヤーの画面位置（parent 畳み込み後の
// worldTransform 平行移動成分）を取る。resolve は純関数（INV-1）で、現フレームで
// 可視なオブジェクトのみ返す＝読み順は「今表示されている text レイヤー」を対象にする。

import type { Frame, TimelineComposition } from "../../core/schema";
import { resolve } from "../../runtime/resolve";

export function textLayerPositions(
  comp: TimelineComposition,
  frame: Frame,
): Map<string, { x: number; y: number }> {
  const map = new Map<string, { x: number; y: number }>();
  try {
    const scene = resolve(comp, frame);
    for (const ro of scene.objects) {
      // 列優先 Mat4 の平行移動成分 = 画面上のアンカー位置。
      map.set(ro.id, { x: ro.worldTransform[12], y: ro.worldTransform[13] });
    }
  } catch {
    // resolve 失敗時は空（reading 対象なし）にフォールバックする。
  }
  return map;
}
