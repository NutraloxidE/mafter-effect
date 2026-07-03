/** 2視点 DLT 三角測量（正規化座標）。 */

export type Vec3Tuple = [number, number, number];

/** P = [R|t] 3x4, X_cam = R X_w + t。正規化画像点 (x,y,1)。 */
export function triangulateLinear(
  P0: number[][],
  P1: number[][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Vec3Tuple | null {
  // A X = 0, A is 4x4
  const A = [
    [
      x0 * P0[2]![0]! - P0[0]![0]!,
      x0 * P0[2]![1]! - P0[0]![1]!,
      x0 * P0[2]![2]! - P0[0]![2]!,
      x0 * P0[2]![3]! - P0[0]![3]!,
    ],
    [
      y0 * P0[2]![0]! - P0[1]![0]!,
      y0 * P0[2]![1]! - P0[1]![1]!,
      y0 * P0[2]![2]! - P0[1]![2]!,
      y0 * P0[2]![3]! - P0[1]![3]!,
    ],
    [
      x1 * P1[2]![0]! - P1[0]![0]!,
      x1 * P1[2]![1]! - P1[0]![1]!,
      x1 * P1[2]![2]! - P1[0]![2]!,
      x1 * P1[2]![3]! - P1[0]![3]!,
    ],
    [
      y1 * P1[2]![0]! - P1[1]![0]!,
      y1 * P1[2]![1]! - P1[1]![1]!,
      y1 * P1[2]![2]! - P1[1]![2]!,
      y1 * P1[2]![3]! - P1[1]![3]!,
    ],
  ];
  const X = nullspace4(A);
  if (!X || Math.abs(X[3]!) < 1e-12) return null;
  return [X[0]! / X[3]!, X[1]! / X[3]!, X[2]! / X[3]!];
}

function nullspace4(A: number[][]): number[] | null {
  // AtA 4x4 smallest eigenvector
  const AtA = Array.from({ length: 4 }, () => Array<number>(4).fill(0));
  for (let i = 0; i < 4; i++) {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        AtA[r]![c]! += A[i]![r]! * A[i]![c]!;
      }
    }
  }
  let v = [0.1, 0.2, 0.3, 1];
  for (let it = 0; it < 50; it++) {
    // inverse iteration with shift
    const M = AtA.map((row, r) => row.map((x, c) => (r === c ? x + 1e-9 : x)));
    const x = v.slice();
    for (let gs = 0; gs < 30; gs++) {
      for (let r = 0; r < 4; r++) {
        let s = v[r]!;
        for (let c = 0; c < 4; c++) if (c !== r) s -= M[r]![c]! * x[c]!;
        x[r] = s / M[r]![r]!;
      }
    }
    const n = Math.hypot(x[0]!, x[1]!, x[2]!, x[3]!) || 1;
    v = x.map((a) => a / n);
  }
  return v;
}

/** cam0 を世界原点: P0 = [I|0], P1 = [R|t]（X1 = R X0 + t）。 */
export function makeProjectionPair(
  R: number[][],
  t: number[],
): { P0: number[][]; P1: number[][] } {
  const P0 = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ];
  const P1 = [
    [R[0]![0]!, R[0]![1]!, R[0]![2]!, t[0]!],
    [R[1]![0]!, R[1]![1]!, R[1]![2]!, t[1]!],
    [R[2]![0]!, R[2]![1]!, R[2]![2]!, t[2]!],
  ];
  return { P0, P1 };
}

export function depthInCamera(R: number[][], t: number[], X: Vec3Tuple): number {
  return R[2]![0]! * X[0] + R[2]![1]! * X[1] + R[2]![2]! * X[2] + t[2]!;
}
