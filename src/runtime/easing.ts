import type { Easing } from "../core/schema";

// §5.3 / §10 イージング。区間内の正規化時間 t∈[0,1] を再マップした t'∈[0,1] を返す。
// 値補間は lerp(v0, v1, t')（§6.4）。hold はステップ（区間全体で v0）。

/**
 * CSS cubic-bezier(x1,y1,x2,y2) と同じ評価。
 * 制御点 P0=(0,0), P3=(1,1) 固定。入力 t は時間軸の進捗、出力は y（値の進捗）。
 */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (t: number) => number {
  // ベジェ成分: B(s) = 3(1-s)^2 s P1 + 3(1-s) s^2 P2 + s^3
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const sampleDX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

  // 与えられた x（=t）に対応するパラメータ s を Newton-Raphson + 二分法で解く。
  const solveS = (x: number): number => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const xs = sampleX(s) - x;
      if (Math.abs(xs) < 1e-7) return s;
      const d = sampleDX(s);
      if (Math.abs(d) < 1e-7) break;
      s -= xs / d;
    }
    // フォールバック: 二分法
    let lo = 0;
    let hi = 1;
    s = x;
    while (lo < hi) {
      const xs = sampleX(s);
      if (Math.abs(xs - x) < 1e-7) break;
      if (x > xs) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
      if (hi - lo < 1e-7) break;
    }
    return s;
  };

  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solveS(t));
  };
}

/**
 * Easing を時間再マップ関数へ解決する。
 * - linear: 恒等
 * - bezier: cubicBezier
 * - hold: ステップ（区間全体で開始値 → t'=0 を返す）
 * - preset: MVP では presets ローダ未実装のため linear フォールバック（§10, 後続で解決）。
 */
export function easingFn(easing: Easing): (t: number) => number {
  switch (easing.type) {
    case "linear":
      return (t) => t;
    case "hold":
      return () => 0;
    case "bezier": {
      const [x1, y1, x2, y2] = easing.bezier;
      return cubicBezier(x1, y1, x2, y2);
    }
    case "preset":
      // TODO(§10): presets/easing/<id>.json を解決。現状は linear。
      return (t) => t;
  }
}
