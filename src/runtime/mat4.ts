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

const RAD2DEG = 180 / Math.PI;

/**
 * anchor=0 の T(position)·R(euler ZYX)·S(scale) 行列を成分に分解する。
 * 入力は shear なしの TRS を想定（グリフ焼き込み用）。
 */
export function decomposeTrs(m: Mat4): { position: Vec3; rotation: Vec3; scale: Vec3 } {
  const position: Vec3 = { x: m[12], y: m[13], z: m[14] };

  const sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);

  const scale: Vec3 = {
    x: sx > 1e-10 ? sx : 1,
    y: sy > 1e-10 ? sy : 1,
    z: sz > 1e-10 ? sz : 1,
  };

  const r00 = m[0] / scale.x;
  const r10 = m[1] / scale.x;
  const r20 = m[2] / scale.x;
  const r01 = m[4] / scale.y;
  const r11 = m[5] / scale.y;
  const r21 = m[6] / scale.y;
  const r22 = m[10] / scale.z;

  const syAng = Math.hypot(r00, r10);
  let rx: number;
  let ry: number;
  let rz: number;
  if (syAng > 1e-6) {
    rz = Math.atan2(r10, r00);
    ry = Math.atan2(-r20, syAng);
    rx = Math.atan2(r21, r22);
  } else {
    rz = Math.atan2(-r01, r11);
    ry = Math.atan2(-r20, syAng);
    rx = 0;
  }

  return {
    position,
    rotation: { x: rx * RAD2DEG, y: ry * RAD2DEG, z: rz * RAD2DEG },
    scale,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Vec3 ヘルパ（camera lookAt / 法線計算用）。INV-1: 純粋・副作用なし。
// ─────────────────────────────────────────────────────────────────────────
export function vecSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vecScale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function vecDot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vecCross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function vecLength(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

/** 正規化。長さ≈0 のときは {0,0,0}。 */
export function vecNormalize(a: Vec3): Vec3 {
  const len = vecLength(a);
  return len > 1e-10 ? { x: a.x / len, y: a.y / len, z: a.z / len } : { x: 0, y: 0, z: 0 };
}

/**
 * 右手系ビュー行列（camera が center を向く）。gl-matrix と同じ規約・column-major。
 * カメラは -z 方向を見る（zaxis = normalize(eye-center)）。Three.js / WebGL と互換。
 * ツーノードカメラ（§6.5）の view = lookAt(position, pointOfInterest, up)。
 */
export function lookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  const z = vecNormalize(vecSub(eye, center)); // 後方（カメラ→視点の逆）
  // eye≈center の退化時は単位回転＋平行移動で代替。
  if (vecLength(vecSub(eye, center)) < 1e-10) {
    return translation(-eye.x, -eye.y, -eye.z);
  }
  let x = vecCross(up, z); // 右
  if (vecLength(x) < 1e-10) {
    // up が z と平行: up を僅かに傾けて再計算。
    x = vecCross({ x: up.x + 1e-4, y: up.y, z: up.z }, z);
  }
  x = vecNormalize(x);
  const y = vecCross(z, x); // 上（既に正規）
  // column-major: 各列は基底ベクトル、平行移動は -dot(axis, eye)。
  return [
    x.x, y.x, z.x, 0,
    x.y, y.y, z.y, 0,
    x.z, y.z, z.z, 0,
    -vecDot(x, eye), -vecDot(y, eye), -vecDot(z, eye), 1,
  ];
}

/**
 * 右手系透視投影行列（NDC z∈[-1,1], OpenGL/Three.js 規約）。column-major。
 * fovDeg = 垂直画角（度）。aspect = width/height。§6.5/§8。
 */
export function perspective(fovDeg: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan((fovDeg * DEG2RAD) / 2);
  const nf = 1 / (near - far);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ];
}

/**
 * 正射影行列（NDC z∈[-1,1]）。column-major。gl-matrix ortho 互換。
 */
export function orthographic(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): Mat4 {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  return [
    -2 * lr, 0, 0, 0,
    0, -2 * bt, 0, 0,
    0, 0, 2 * nf, 0,
    (left + right) * lr, (top + bottom) * bt, (far + near) * nf, 1,
  ];
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

/** 転置行列（column-major m[c*4+r] → out[r*4+c]）。 */
export function transpose(m: Mat4): Mat4 {
  const out = new Array<number>(16) as Mat4;
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[r * 4 + c] = m[c * 4 + r]!;
    }
  }
  return out;
}

/**
 * §5.5f 法線を world 空間へ運ぶ行列（非一様スケールでも法線が歪まないよう world の逆転置を使う）。
 * world が非可逆（scale=0 等）のときは identity にフォールバック（法線計算が壊れるより見た目が無害な方を選ぶ）。
 */
export function normalMatrix(world: Mat4): Mat4 {
  const inv = invert(world);
  return inv ? transpose(inv) : identity();
}
