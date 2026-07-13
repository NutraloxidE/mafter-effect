import { perspective, type Mat4 } from "../mat4";
import type { MeshData } from "./geom3dTypes";

/**
 * §3 案 B — per-layer 素の WebGL canvas（three.js 不使用）。canvas は「ピクセルを作る手段」でしかなく、
 * DOM のレイヤー構造・matrix3d・blend/filter・export のレイヤー列挙には一切関与しない
 * （webgl-video-layer-plan.md §1 の確立原則を踏襲。videoAlphaGl.ts と同じ WeakMap 登録パターン）。
 *
 * **カメラの簡略化（P1 スコープの明示的な設計判断）**: このセッションでは comp のアクティブカメラ
 * （§6.5）や Transform.rotation を GL 側で適用しない。GL は固定の既定パースペクティブのみを使う
 * （下記 DEFAULT_EYE_DISTANCE_FACTOR）。front cap は常にローカル z=0 で、この固定カメラは
 * z=0 平面をピクセル等倍・無歪みで投影するよう校正されている（§6.5b の translate(cx,cy,P) 中立化と
 * 同じ考え方）ため、depth=0 のときは常に既存 2D 描画と一致する。Transform.rotation は引き続き
 * 既存の CSS matrix3d 経路（entry.div）で見た目に適用されるが、GL 側の奥行き幾何自体は
 * その回転に追従しない（= 回転させると「厚みのある画像を平面カードとして傾ける」近似になる）。
 * 真の per-object 3D 回転応答は次フェーズ（DomRenderer の transform 分離が必要・要設計）。
 */

/** 既定カメラの「奥行き距離 ÷ canvas 高さ」比。大きいほど遠近感が弱くなる（望遠寄り）。 */
const DEFAULT_EYE_DISTANCE_FACTOR = 1.5;
const NEAR = 1;
const FAR = 1_000_000;

const VERTEX_SRC = `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 uView;
uniform mat4 uProjection;
uniform vec3 uLightDir;
uniform float uAmbient;
uniform vec4 uBaseColor;
varying vec4 vColor;
void main() {
  float ndotl = max(0.0, dot(normalize(aNormal), -uLightDir));
  float lighting = clamp(uAmbient + (1.0 - uAmbient) * ndotl, 0.0, 1.0);
  vColor = vec4(uBaseColor.rgb * lighting, uBaseColor.a);
  gl_Position = uProjection * uView * vec4(aPosition, 1.0);
}
`;

const FRAGMENT_SRC = `
precision mediump float;
varying vec4 vColor;
void main() {
  gl_FragColor = vColor;
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`geom3d shader compile failed: ${info ?? "unknown"}`);
  }
  return shader;
}

function linkProgram(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`geom3d program link failed: ${info ?? "unknown"}`);
  }
  return program;
}

interface Geom3DGlState {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  positionBuffer: WebGLBuffer;
  normalBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  aPosition: number;
  aNormal: number;
  uView: WebGLUniformLocation | null;
  uProjection: WebGLUniformLocation | null;
  uLightDir: WebGLUniformLocation | null;
  uAmbient: WebGLUniformLocation | null;
  uBaseColor: WebGLUniformLocation | null;
  /** 直前にアップロードした mesh の参照。同一参照ならバッファ再アップロードをスキップ。 */
  lastMesh: MeshData | null;
  broken: boolean;
}

const statesByCanvas = new WeakMap<HTMLCanvasElement, Geom3DGlState>();

function createState(canvas: HTMLCanvasElement): Geom3DGlState | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    // export のフレームキャプチャは render 直後以外のタイミングで canvas を読むため必須
    // （webgl-video-layer-plan.md §1.2 の教訓）。
    preserveDrawingBuffer: true,
    antialias: true,
    depth: true,
  }) as WebGLRenderingContext | null;
  if (!gl) return null;
  // MeshData.indices は Uint32Array（text は数千頂点になりうるため 16bit の 65535 上限を超えうる）。
  // WebGL1 は既定で 16bit index のみなので拡張を要求する（主要ブラウザでほぼ標準対応）。
  if (!gl.getExtension("OES_element_index_uint")) return null;
  try {
    const program = linkProgram(gl, VERTEX_SRC, FRAGMENT_SRC);
    const positionBuffer = gl.createBuffer();
    const normalBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    if (!positionBuffer || !normalBuffer || !indexBuffer) throw new Error("createBuffer failed");
    return {
      gl,
      program,
      positionBuffer,
      normalBuffer,
      indexBuffer,
      aPosition: gl.getAttribLocation(program, "aPosition"),
      aNormal: gl.getAttribLocation(program, "aNormal"),
      uView: gl.getUniformLocation(program, "uView"),
      uProjection: gl.getUniformLocation(program, "uProjection"),
      uLightDir: gl.getUniformLocation(program, "uLightDir"),
      uAmbient: gl.getUniformLocation(program, "uAmbient"),
      uBaseColor: gl.getUniformLocation(program, "uBaseColor"),
      lastMesh: null,
      broken: false,
    };
  } catch {
    return null;
  }
}

function getOrCreateState(canvas: HTMLCanvasElement): Geom3DGlState | null {
  let state = statesByCanvas.get(canvas);
  if (state && !state.broken) return state;
  const created = createState(canvas);
  if (!created) return null;
  statesByCanvas.set(canvas, created);
  return created;
}

/** 明示解放。レイヤー非表示化・3D トグル OFF・オブジェクト削除時に必ず呼ぶ。 */
export function releaseGeom3DGl(canvas: HTMLCanvasElement): void {
  const state = statesByCanvas.get(canvas);
  if (!state) return;
  const { gl } = state;
  gl.deleteBuffer(state.positionBuffer);
  gl.deleteBuffer(state.normalBuffer);
  gl.deleteBuffer(state.indexBuffer);
  gl.deleteProgram(state.program);
  statesByCanvas.delete(canvas);
}

/** 既定カメラの view/projection（§ ファイル冒頭コメント参照）。canvas 実ピクセルサイズ基準。 */
function buildDefaultCamera(width: number, height: number): { view: Mat4; projection: Mat4 } {
  const eyeDistance = Math.max(1, height) * DEFAULT_EYE_DISTANCE_FACTOR;
  const cx = width / 2;
  const cy = height / 2;
  // (x,y,z) -> (x-cx, -(y-cy), z-eyeDistance)。Y 反転はローカル座標(y-down)と NDC(y-up)の変換。
  const view: Mat4 = [
    1, 0, 0, 0,
    0, -1, 0, 0,
    0, 0, 1, 0,
    -cx, cy, -eyeDistance, 1,
  ];
  const fovDeg = 2 * Math.atan(height / 2 / eyeDistance) * (180 / Math.PI);
  const aspect = width / Math.max(1, height);
  const projection = perspective(fovDeg, aspect, NEAR, FAR);
  return { view, projection };
}

export interface Geom3DRenderOptions {
  width: number;
  height: number;
  baseColor: readonly [number, number, number, number];
  lightDir: readonly [number, number, number];
  ambient: number;
}

/**
 * mesh を canvas に描画する。canvas サイズ（width/height 属性）は呼び出し側が
 * 事前に設定済みであること（devicePixelRatio 等の解像度判断は呼び出し側の責務）。
 * 戻り値 false は GL 未対応/context lost（呼び出し側は 2D フォールバックを検討）。
 */
export function renderGeom3D(canvas: HTMLCanvasElement, mesh: MeshData, opts: Geom3DRenderOptions): boolean {
  const state = getOrCreateState(canvas);
  if (!state) return false;
  const { gl } = state;
  if (gl.isContextLost()) {
    state.broken = true;
    return false;
  }

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.CULL_FACE); // §5.3: 巻き方向の厳密な一貫性を仮定しない（安全側）
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  if (mesh.triangleCount === 0) return true;

  gl.useProgram(state.program);

  if (state.lastMesh !== mesh) {
    gl.bindBuffer(gl.ARRAY_BUFFER, state.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
    state.lastMesh = mesh;
  } else {
    gl.bindBuffer(gl.ARRAY_BUFFER, state.positionBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.indexBuffer);
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, state.positionBuffer);
  gl.enableVertexAttribArray(state.aPosition);
  gl.vertexAttribPointer(state.aPosition, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, state.normalBuffer);
  gl.enableVertexAttribArray(state.aNormal);
  gl.vertexAttribPointer(state.aNormal, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.indexBuffer);

  const { view, projection } = buildDefaultCamera(opts.width, opts.height);
  gl.uniformMatrix4fv(state.uView, false, view);
  gl.uniformMatrix4fv(state.uProjection, false, projection);
  gl.uniform3f(state.uLightDir, opts.lightDir[0], opts.lightDir[1], opts.lightDir[2]);
  gl.uniform1f(state.uAmbient, opts.ambient);
  gl.uniform4f(state.uBaseColor, opts.baseColor[0], opts.baseColor[1], opts.baseColor[2], opts.baseColor[3]);

  gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_INT, 0);
  return true;
}
