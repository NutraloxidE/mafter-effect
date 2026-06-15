import type { Vec3 } from "../core/schema";

// column-major 4x4 行列（§8）。CSS matrix3d() と同じ要素順。
// row r, col c の要素は m[c*4 + r]。列ベクトル v に対し v' = M·v。
export type Mat4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

// C = A·B（column-major）。C[c*4+r] = Σ_k A[k*4+r]·B[c*4+k]
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16) as Mat4;
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) {
        s += a[k * 4 + r]! * b[c * 4 + k]!;
      }
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** 複数行列を左から順に掛ける: multiplyAll(A,B,C) = A·B·C */
export function multiplyAll(...mats: Mat4[]): Mat4 {
  return mats.reduce((acc, m) => multiply(acc, m), identity());
}

export function translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function scaling(x: number, y: number, z: number): Mat4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

const DEG2RAD = Math.PI / 180;

export function rotationX(deg: number): Mat4 {
  const r = deg * DEG2RAD;
  const c = Math.cos(r);
  const s = Math.sin(r);
  // row-major [[1,0,0],[0,c,-s],[0,s,c]] → column-major
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

export function rotationY(deg: number): Mat4 {
  const r = deg * DEG2RAD;
  const c = Math.cos(r);
  const s = Math.sin(r);
  // row-major [[c,0,s],[0,1,0],[-s,0,c]] → column-major
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

export function rotationZ(deg: number): Mat4 {
  const r = deg * DEG2RAD;
  const c = Math.cos(r);
  const s = Math.sin(r);
  // row-major [[c,-s,0],[s,c,0],[0,0,1]] → column-major
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** euler 適用順 Z·Y·X（§6.3）: R = Rz·Ry·Rx */
export function rotationEuler(rot: Vec3): Mat4 {
  return multiplyAll(rotationZ(rot.z), rotationY(rot.y), rotationX(rot.x));
}

/**
 * ローカル変換 L = T(position)·R(rotation)·S(scale)·T(-anchor)（§6.3 確定）。
 * anchor は回転・スケールのピボット（行列に内包、DomRenderer は transform-origin:0 0）。
 */
export function localMatrix(
  anchor: Vec3,
  position: Vec3,
  rotation: Vec3,
  scale: Vec3,
): Mat4 {
  return multiplyAll(
    translation(position.x, position.y, position.z),
    rotationEuler(rotation),
    scaling(scale.x, scale.y, scale.z),
    translation(-anchor.x, -anchor.y, -anchor.z),
  );
}

/** 点 p（同次 w=1）に行列を適用する。 */
export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
  const y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
  const z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
  const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
  return w !== 0 && w !== 1 ? { x: x / w, y: y / w, z: z / w } : { x, y, z };
}

/**
 * 4x4 逆行列（camera view 行列 = world の逆, §6.5）。
 * 非可逆（det≈0）のときは null。
 */
export function invert(m: Mat4): Mat4 | null {
  const inv = new Array<number>(16);

  inv[0] =
    m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] +
    m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] =
    -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] -
    m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] =
    m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] +
    m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] =
    -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] -
    m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] =
    -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] -
    m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] =
    m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] +
    m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] =
    -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] -
    m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] =
    m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] +
    m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] =
    m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] +
    m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] =
    -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] -
    m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] =
    m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] +
    m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] =
    -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] -
    m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] =
    -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] -
    m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] =
    m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] +
    m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] =
    -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] -
    m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] =
    m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] +
    m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];

  let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (det === 0 || !Number.isFinite(det)) return null;
  det = 1.0 / det;
  return inv.map((v) => v * det) as Mat4;
}
