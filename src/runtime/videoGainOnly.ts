// §11.5.2 declick を「重い視覚描画から切り離して」毎フレーム必ず適用するための軽量抽出。
//
// resolve() のフル解決（transform/effects/DOM 反映）はコストが高く、bundle の適応スキップ
// （adaptiveRenderBudget）は意図的にこれを間引く。既存の declick は resolve() の中でしか
// gain へ焼き込まれないため、間引かれたフレームでは continuity フェードが video.volume に
// 反映されない（ループ継ぎ目でクリック音）。この関数は video component の gain だけを、
// resolve() と同じ式（raw gain × autoFadeMultiplierAtFrame）で求める。フェード演算そのものは
// footageAutoFade.ts を re-export するだけで重複させない（INV-2: 全経路が同じ関数を共有）。
//
// renderGate に関係なく毎フレーム呼べることが要件のため、transform・effect・DOM には触れない。

import type { ExpressionEvaluator } from "./resolve";
import type { Frame, ObjectId, TimelineComposition } from "../core/schema";
import { readGainProp } from "./footageAudio";
import { sampleScalar } from "./interpolate";
import {
  autoFadeMultiplierAtFrame,
  collectFadeClips,
  computeFadeSuppression,
  isAutoFadeEnabled,
} from "./footageAutoFade";

/** frame における各 video レイヤーの declick 込み gain（0..1）。visible でないレイヤーは含まない。 */
export function resolveVideoGainForFrame(
  comp: TimelineComposition,
  frame: Frame,
  evaluator?: ExpressionEvaluator,
): Map<ObjectId, number> {
  const out = new Map<ObjectId, number>();
  const fadeSuppression = computeFadeSuppression(collectFadeClips(comp));
  for (const obj of comp.objects) {
    if (!obj.enabled || frame < obj.inPoint || frame >= obj.outPoint) continue;
    const videoCmp = obj.components.find((c) => c.type === "video");
    if (!videoCmp) continue;
    const gainProp = readGainProp(videoCmp.props["gain"]);
    let gain = sampleScalar(gainProp, frame);
    const ex = gainProp.expression;
    if (ex?.enabled && evaluator) {
      try {
        const r = evaluator({ path: ex.path, frame, fps: comp.fps, value: gain, objectId: obj.id });
        if (typeof r === "number") gain = r;
      } catch {
        /* §9 フォールバック: sampled 値を維持 */
      }
    }
    if (isAutoFadeEnabled(videoCmp.props)) {
      gain *= autoFadeMultiplierAtFrame(frame, {
        inPoint: obj.inPoint,
        outPoint: obj.outPoint,
        fps: comp.fps,
        suppression: fadeSuppression.get(obj.id),
      });
    }
    out.set(obj.id, Math.max(0, Math.min(1, gain)));
  }
  return out;
}
