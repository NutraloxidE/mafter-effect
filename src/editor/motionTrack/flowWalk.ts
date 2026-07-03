import type { RawQuaternion, RawTranslation } from "./types";
import type { PixelPair } from "./essentialPose";
import { medianFlowPx } from "./essentialPose";

/**
 * フロー場から歩き撮り 1 ステップを推定（FOE + 発散 + 平均フロー）。
 * essential が不安定な単眼ドリーでも前進・チルトを拾いやすい。
 */
export function estimateWalkStepFromFlow(
  pairs: PixelPair[],
  width: number,
  height: number,
  focalLength: number,
): { motion: RawTranslation; rotation: RawQuaternion; scale: number } | null {
  if (pairs.length < 8) return null;
  const cx = width / 2;
  const cy = height / 2;
  const f = Math.max(1, focalLength);

  let sumU = 0;
  let sumV = 0;
  const radials: number[] = [];
  for (const p of pairs) {
    const u = p.x1 - p.x0;
    const v = p.y1 - p.y0;
    sumU += u;
    sumV += v;
    const mx = (p.x0 + p.x1) / 2 - cx;
    const my = (p.y0 + p.y1) / 2 - cy;
    const r = Math.hypot(mx, my);
    if (r > 8) {
      // 放射方向成分（拡大 = 前進）
      radials.push((u * mx + v * my) / r);
    }
  }
  const n = pairs.length;
  const meanU = sumU / n;
  const meanV = sumV / n;
  const medFlow = medianFlowPx(pairs);
  if (medFlow < 0.15) return null;

  const radSorted = [...radials].sort((a, b) => a - b);
  const medRadial =
    radSorted.length === 0
      ? 0
      : radSorted[Math.floor(radSorted.length / 2)]!;

  // カメラ運動（cam 系 +z 奥）: 特徴が外へ広がる → カメラ前進 (+z)
  // 特徴が右へ → カメラ左 (-x)、下へ → カメラ上 (-y) in image coords (+y down)
  const tx = -meanU;
  const ty = -meanV;
  const tz = Math.max(0, medRadial); // 拡大のみ前進として採用
  const motionLen = Math.hypot(tx, ty, tz);
  if (motionLen < 1e-6) return null;
  const motion: RawTranslation = [tx / motionLen, ty / motionLen, tz / motionLen];

  // 小角度回転（rad）。画像フローとカメラ回転は逆向き:
  // カメラが上を向く → 特徴は下へ (+v) → pitch は負（composeBaselineRotation 後にゲージが上向き）
  // カメラが右を向く → 特徴は左へ (-u) → yaw は正
  const pitch = -meanV / f;
  const yaw = meanU / f;
  const roll = 0;
  const rotation = smallEulerToQuaternion(pitch, yaw, roll);
  const scale = Math.max(0.5, medFlow);

  return { motion, rotation, scale };
}

function smallEulerToQuaternion(rx: number, ry: number, rz: number): RawQuaternion {
  const hx = rx * 0.5;
  const hy = ry * 0.5;
  const hz = rz * 0.5;
  const cx = Math.cos(hx);
  const sx = Math.sin(hx);
  const cy = Math.cos(hy);
  const sy = Math.sin(hy);
  const cz = Math.cos(hz);
  const sz = Math.sin(hz);
  // ZYX
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}
