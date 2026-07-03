/**
 * SfM ソルバの数学基盤（純関数・依存なし）。
 * 3D Solve モード専用。walk / rotation の既存経路には触れない（隔離）。
 */

export type V3 = [number, number, number];
/** row-major 3x3 */
export type M3 = [V3, V3, V3];

export function v3(x: number, y: number, z: number): V3 {
  return [x, y, z];
}

export function v3Add(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function v3Sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function v3Scale(a: V3, s: number): V3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function v3Dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function v3Cross(a: V3, b: V3): V3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function v3Norm(a: V3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function v3Normalize(a: V3): V3 {
  const n = v3Norm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
}

export function m3Identity(): M3 {
  return [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
}

export function m3Mul(A: M3, B: M3): M3 {
  const out = m3Identity();
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r]![c] = A[r]![0]! * B[0][c]! + A[r]![1]! * B[1][c]! + A[r]![2]! * B[2][c]!;
    }
  }
  return out;
}

export function m3MulVec(A: M3, x: V3): V3 {
  return [
    A[0][0] * x[0] + A[0][1] * x[1] + A[0][2] * x[2],
    A[1][0] * x[0] + A[1][1] * x[1] + A[1][2] * x[2],
    A[2][0] * x[0] + A[2][1] * x[1] + A[2][2] * x[2],
  ];
}

export function m3Transpose(A: M3): M3 {
  return [
    [A[0][0], A[1][0], A[2][0]],
    [A[0][1], A[1][1], A[2][1]],
    [A[0][2], A[1][2], A[2][2]],
  ];
}

export function m3Det(A: M3): number {
  return (
    A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
    A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
    A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0])
  );
}

/** Rodrigues: angle-axis → 回転行列。 */
export function so3Exp(w: V3): M3 {
  const theta = v3Norm(w);
  if (theta < 1e-12) {
    // 1次近似で十分（|w| ≈ 0）
    return [
      [1, -w[2], w[1]],
      [w[2], 1, -w[0]],
      [-w[1], w[0], 1],
    ];
  }
  const k = v3Scale(w, 1 / theta);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const t = 1 - c;
  const [kx, ky, kz] = k;
  return [
    [c + kx * kx * t, kx * ky * t - kz * s, kx * kz * t + ky * s],
    [ky * kx * t + kz * s, c + ky * ky * t, ky * kz * t - kx * s],
    [kz * kx * t - ky * s, kz * ky * t + kx * s, c + kz * kz * t],
  ];
}

/** 回転行列 → angle-axis。 */
export function so3Log(R: M3): V3 {
  const tr = R[0][0] + R[1][1] + R[2][2];
  const cosTheta = Math.min(1, Math.max(-1, (tr - 1) / 2));
  const theta = Math.acos(cosTheta);
  if (theta < 1e-8) {
    return [
      (R[2][1] - R[1][2]) / 2,
      (R[0][2] - R[2][0]) / 2,
      (R[1][0] - R[0][1]) / 2,
    ];
  }
  if (Math.PI - theta < 1e-5) {
    // theta ≈ π: 対角から軸を復元
    const xx = Math.sqrt(Math.max(0, (R[0][0] + 1) / 2));
    const yy = Math.sqrt(Math.max(0, (R[1][1] + 1) / 2));
    const zz = Math.sqrt(Math.max(0, (R[2][2] + 1) / 2));
    // 符号は非対角から
    let axis: V3 = [xx, yy, zz];
    if (xx >= yy && xx >= zz) {
      axis = [xx, R[0][1] / (2 * xx || 1), R[0][2] / (2 * xx || 1)];
    } else if (yy >= zz) {
      axis = [R[0][1] / (2 * yy || 1), yy, R[1][2] / (2 * yy || 1)];
    } else {
      axis = [R[0][2] / (2 * zz || 1), R[1][2] / (2 * zz || 1), zz];
    }
    return v3Scale(v3Normalize(axis), theta);
  }
  const s = 2 * Math.sin(theta);
  return [
    ((R[2][1] - R[1][2]) / s) * theta,
    ((R[0][2] - R[2][0]) / s) * theta,
    ((R[1][0] - R[0][1]) / s) * theta,
  ];
}

/** [qx, qy, qz, qw] */
export type Quat = [number, number, number, number];

export function m3ToQuat(R: M3): Quat {
  const tr = R[0][0] + R[1][1] + R[2][2];
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return [(R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s, s / 4];
  }
  if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
    const s = Math.sqrt(1 + R[0][0] - R[1][1] - R[2][2]) * 2;
    return [s / 4, (R[0][1] + R[1][0]) / s, (R[0][2] + R[2][0]) / s, (R[2][1] - R[1][2]) / s];
  }
  if (R[1][1] > R[2][2]) {
    const s = Math.sqrt(1 + R[1][1] - R[0][0] - R[2][2]) * 2;
    return [(R[0][1] + R[1][0]) / s, s / 4, (R[1][2] + R[2][1]) / s, (R[0][2] - R[2][0]) / s];
  }
  const s = Math.sqrt(1 + R[2][2] - R[0][0] - R[1][1]) * 2;
  return [(R[0][2] + R[2][0]) / s, (R[1][2] + R[2][1]) / s, s / 4, (R[1][0] - R[0][1]) / s];
}

export function quatToM3(q: Quat): M3 {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (dot > 0.9995) {
    return quatNormalize([
      a[0] + t * (bx - a[0]),
      a[1] + t * (by - a[1]),
      a[2] + t * (bz - a[2]),
      a[3] + t * (bw - a[3]),
    ]);
  }
  const theta0 = Math.acos(Math.min(1, dot));
  const theta = theta0 * t;
  const s0 = Math.cos(theta) - (dot * Math.sin(theta)) / Math.sin(theta0);
  const s1 = Math.sin(theta) / Math.sin(theta0);
  return quatNormalize([
    s0 * a[0] + s1 * bx,
    s0 * a[1] + s1 * by,
    s0 * a[2] + s1 * bz,
    s0 * a[3] + s1 * bw,
  ]);
}

/** 決定論 RANSAC 用 seeded RNG（mulberry32）。 */
export class SfmRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  /** 重複なしで k 個サンプル。 */
  sample(n: number, k: number): number[] {
    const out: number[] = [];
    const used = new Set<number>();
    let guard = 0;
    while (out.length < k && guard++ < 1000) {
      const i = this.int(n);
      if (used.has(i)) continue;
      used.add(i);
      out.push(i);
    }
    return out;
  }
}

/** Huber 重み（residual ノルム r に対する IRLS 重み sqrt(w)）。 */
export function huberSqrtWeight(r: number, delta: number): number {
  if (r <= delta) return 1;
  return Math.sqrt(delta / r);
}

/**
 * 対称正定値 n×n の LDLᵀ 分解による解法（in-place コピー・小 ridge 付き）。
 * A は row-major Float64Array(n*n)。失敗時 null。
 */
export function solveSymmetric(
  A: Float64Array,
  b: Float64Array,
  n: number,
  ridge = 1e-10,
): Float64Array | null {
  const L = new Float64Array(A);
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) L[i * n + i]! += ridge;

  for (let j = 0; j < n; j++) {
    let dj = L[j * n + j]!;
    for (let k = 0; k < j; k++) {
      const ljk = L[j * n + k]!;
      dj -= ljk * ljk * d[k]!;
    }
    if (!(Math.abs(dj) > 1e-14)) return null;
    d[j] = dj;
    for (let i = j + 1; i < n; i++) {
      let lij = L[i * n + j]!;
      for (let k = 0; k < j; k++) {
        lij -= L[i * n + k]! * L[j * n + k]! * d[k]!;
      }
      L[i * n + j] = lij / dj;
    }
  }

  // forward: L y = b
  const y = new Float64Array(b);
  for (let i = 0; i < n; i++) {
    let s = y[i]!;
    for (let k = 0; k < i; k++) s -= L[i * n + k]! * y[k]!;
    y[i] = s;
  }
  // diag: D z = y
  for (let i = 0; i < n; i++) y[i]! /= d[i]!;
  // backward: Lᵀ x = z
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let k = i + 1; k < n; k++) s -= L[k * n + i]! * y[k]!;
    y[i] = s;
  }
  return y;
}

/** 3x3 対称の逆行列（BA の point ブロック用）。失敗時 null。 */
export function invSym3(A: M3): M3 | null {
  const a = A[0][0];
  const b = A[0][1];
  const c = A[0][2];
  const d = A[1][1];
  const e = A[1][2];
  const f = A[2][2];
  const co00 = d * f - e * e;
  const co01 = c * e - b * f;
  const co02 = b * e - c * d;
  const det = a * co00 + b * co01 + c * co02;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  const inv = 1 / det;
  const co11 = a * f - c * c;
  const co12 = b * c - a * e;
  const co22 = a * d - b * b;
  return [
    [co00 * inv, co01 * inv, co02 * inv],
    [co01 * inv, co11 * inv, co12 * inv],
    [co02 * inv, co12 * inv, co22 * inv],
  ];
}

/** 対称 3x3 の Jacobi 固有分解（固有値降順）。 */
export function eigenSym3(M: M3): { vals: V3; vecs: [V3, V3, V3] } {
  const A: number[][] = M.map((r) => [...r]);
  const V: number[][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 50; iter++) {
    let p = 0;
    let q = 1;
    let max = Math.abs(A[0]![1]!);
    for (const [i, j] of [
      [0, 2],
      [1, 2],
    ] as const) {
      const v = Math.abs(A[i]![j]!);
      if (v > max) {
        max = v;
        p = i;
        q = j;
      }
    }
    if (max < 1e-13) break;
    const app = A[p]![p]!;
    const aqq = A[q]![q]!;
    const apq = A[p]![q]!;
    const tau = (aqq - app) / (2 * apq);
    const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    A[p]![p] = app - t * apq;
    A[q]![q] = aqq + t * apq;
    A[p]![q] = 0;
    A[q]![p] = 0;
    for (let r = 0; r < 3; r++) {
      if (r === p || r === q) continue;
      const arp = A[r]![p]!;
      const arq = A[r]![q]!;
      A[r]![p] = c * arp - s * arq;
      A[p]![r] = A[r]![p]!;
      A[r]![q] = s * arp + c * arq;
      A[q]![r] = A[r]![q]!;
    }
    for (let r = 0; r < 3; r++) {
      const vrp = V[r]![p]!;
      const vrq = V[r]![q]!;
      V[r]![p] = c * vrp - s * vrq;
      V[r]![q] = s * vrp + c * vrq;
    }
  }
  const entries: Array<{ val: number; vec: V3 }> = [0, 1, 2].map((i) => ({
    val: A[i]![i]!,
    vec: [V[0]![i]!, V[1]![i]!, V[2]![i]!] as V3,
  }));
  entries.sort((a, b) => b.val - a.val);
  return {
    vals: [entries[0]!.val, entries[1]!.val, entries[2]!.val],
    vecs: [entries[0]!.vec, entries[1]!.vec, entries[2]!.vec],
  };
}

/** 3x3 SVD（AᵀA の固有分解経由・essential 分解用）。 */
export function svd3(A: M3): { U: M3; S: V3; V: M3 } {
  const AtA = m3Mul(m3Transpose(A), A);
  const { vals, vecs } = eigenSym3(AtA);
  const S: V3 = [
    Math.sqrt(Math.max(0, vals[0])),
    Math.sqrt(Math.max(0, vals[1])),
    Math.sqrt(Math.max(0, vals[2])),
  ];
  // V の列 = vecs
  const V: M3 = [
    [vecs[0][0], vecs[1][0], vecs[2][0]],
    [vecs[0][1], vecs[1][1], vecs[2][1]],
    [vecs[0][2], vecs[1][2], vecs[2][2]],
  ];
  // U 列 = A v_i / s_i → Gram-Schmidt で直交化
  const cols: V3[] = [];
  for (let i = 0; i < 3; i++) {
    const vcol: V3 = [V[0][i]!, V[1][i]!, V[2][i]!];
    const Av = m3MulVec(A, vcol);
    const s = S[i]! > 1e-12 ? S[i]! : 1;
    cols.push(v3Scale(Av, 1 / s));
  }
  const u0 = v3Normalize(cols[0]!);
  let u1 = v3Sub(cols[1]!, v3Scale(u0, v3Dot(cols[1]!, u0)));
  if (v3Norm(u1) < 1e-9) u1 = v3Cross(u0, [1, 0, 0]);
  if (v3Norm(u1) < 1e-9) u1 = v3Cross(u0, [0, 1, 0]);
  u1 = v3Normalize(u1);
  const u2 = v3Cross(u0, u1);
  const U: M3 = [
    [u0[0], u1[0], u2[0]],
    [u0[1], u1[1], u2[1]],
    [u0[2], u1[2], u2[2]],
  ];
  return { U, S, V };
}

/**
 * 対称 n×n（row-major Float64Array）の最小固有値に対応する固有ベクトル。
 * 巡回 Jacobi 法（n ≤ 20 程度想定・8-point / DLT の nullspace 用）。
 */
export function smallestEigenvectorSym(A: Float64Array, n: number): Float64Array | null {
  if (A.length !== n * n) return null;
  const a = new Float64Array(A);
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;

  for (let sweep = 0; sweep < 40; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) off += a[p * n + q]! * a[p * n + q]!;
    }
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q]!;
        if (Math.abs(apq) < 1e-18) continue;
        const app = a[p * n + p]!;
        const aqq = a[q * n + q]!;
        const tau = (aqq - app) / (2 * apq);
        const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;
        a[p * n + p] = app - t * apq;
        a[q * n + q] = aqq + t * apq;
        a[p * n + q] = 0;
        a[q * n + p] = 0;
        for (let r = 0; r < n; r++) {
          if (r === p || r === q) continue;
          const arp = a[r * n + p]!;
          const arq = a[r * n + q]!;
          a[r * n + p] = c * arp - s * arq;
          a[p * n + r] = a[r * n + p]!;
          a[r * n + q] = s * arp + c * arq;
          a[q * n + r] = a[r * n + q]!;
        }
        for (let r = 0; r < n; r++) {
          const vrp = V[r * n + p]!;
          const vrq = V[r * n + q]!;
          V[r * n + p] = c * vrp - s * vrq;
          V[r * n + q] = s * vrp + c * vrq;
        }
      }
    }
  }

  let minIdx = 0;
  let minVal = a[0]!;
  for (let i = 1; i < n; i++) {
    if (a[i * n + i]! < minVal) {
      minVal = a[i * n + i]!;
      minIdx = i;
    }
  }
  const out = new Float64Array(n);
  for (let r = 0; r < n; r++) out[r] = V[r * n + minIdx]!;
  return out;
}

export function median(nums: number[]): number {
  if (nums.length === 0) return Infinity;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

/** カメラポーズ（X_cam = R·X_world + t）。 */
export interface CamPose {
  R: M3;
  t: V3;
}

export function cameraCenter(pose: CamPose): V3 {
  // C = -Rᵀ t
  const Rt = m3Transpose(pose.R);
  return v3Scale(m3MulVec(Rt, pose.t), -1);
}

export function poseFromCenter(R: M3, C: V3): CamPose {
  // t = -R C
  return { R, t: v3Scale(m3MulVec(R, C), -1) };
}

/** ピンホール投影（fx=fy=f、主点 cx,cy）。z<=0 なら null。 */
export function projectPoint(
  pose: CamPose,
  f: number,
  cx: number,
  cy: number,
  X: V3,
): { u: number; v: number; z: number } | null {
  const p = v3Add(m3MulVec(pose.R, X), pose.t);
  if (p[2] <= 1e-9) return null;
  return { u: (f * p[0]) / p[2] + cx, v: (f * p[1]) / p[2] + cy, z: p[2] };
}

/**
 * 2 視点 DLT 三角測量（正規化画像座標・P = [R|t]）。
 * 4×4 AᵀA の最小固有ベクトルを Jacobi で解く（既存 triangulate.ts の
 * Gauss-Seidel 逆反復は精度不足のため solve 経路では使わない）。
 */
export function triangulateDlt(
  P0: CamPose,
  P1: CamPose,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): V3 | null {
  const rows: number[][] = [];
  const pushRows = (P: CamPose, x: number, y: number) => {
    const { R, t } = P;
    rows.push([
      x * R[2][0] - R[0][0],
      x * R[2][1] - R[0][1],
      x * R[2][2] - R[0][2],
      x * t[2] - t[0],
    ]);
    rows.push([
      y * R[2][0] - R[1][0],
      y * R[2][1] - R[1][1],
      y * R[2][2] - R[1][2],
      y * t[2] - t[1],
    ]);
  };
  pushRows(P0, x0, y0);
  pushRows(P1, x1, y1);
  const AtA = new Float64Array(16);
  for (const row of rows) {
    for (let r = 0; r < 4; r++) {
      for (let c = r; c < 4; c++) AtA[r * 4 + c]! += row[r]! * row[c]!;
    }
  }
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < r; c++) AtA[r * 4 + c] = AtA[c * 4 + r]!;
  }
  const v = smallestEigenvectorSym(AtA, 4);
  if (!v || Math.abs(v[3]!) < 1e-12) return null;
  return [v[0]! / v[3]!, v[1]! / v[3]!, v[2]! / v[3]!];
}

/** 2 視点の視線ベクトルのなす角（度）。三角測量の条件判定用。 */
export function triangulationAngleDeg(C0: V3, C1: V3, X: V3): number {
  const d0 = v3Normalize(v3Sub(X, C0));
  const d1 = v3Normalize(v3Sub(X, C1));
  const c = Math.min(1, Math.max(-1, v3Dot(d0, d1)));
  return (Math.acos(c) * 180) / Math.PI;
}
