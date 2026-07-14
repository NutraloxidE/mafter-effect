import type { Mat4 } from "../mat4";
import type { MeshData } from "./geom3dTypes";

/**
 * §5.5f 案 B — per-layer 素の WebGL canvas（three.js 不使用）。canvas は「ピクセルを作る手段」でしかなく、
 * DOM のレイヤー構造・matrix3d・blend/filter・export のレイヤー列挙には一切関与しない
 * （webgl-video-layer-plan.md §1 の確立原則を踏襲。videoAlphaGl.ts と同じ WeakMap 登録パターン）。
 *
 * **実 MVP 投影（P2・再設計）**: comp のアクティブカメラ（§6.5）と Transform（回転含む）を
 * 呼び出し側（geom3dDomApply.ts）が `mvp = Proj·cameraPre·worldTransform` として合成し、
 * このモジュールは行列を掛けるだけの薄い GL レイヤーに徹する。camera 無し・回転無し・depth=0 のとき
 * mvp は既存 2D 描画とピクセル一致するよう呼び出し側で中立化される（このファイルはそれを仮定しない）。
 * ライティングは comp/world 空間の平行光（`uLightDirWorld`）を `uNormalMatrix`（= world の逆転置）で
 * 変換した法線と内積する＝オブジェクトを回転させると陰影が正しく面を横断する。
 */

const VERTEX_SRC = `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 uMVP;
uniform mat4 uNormalMatrix;
uniform vec3 uLightDirWorld;
uniform float uAmbient;
uniform vec4 uBaseColor;
varying vec4 vColor;
void main() {
  vec3 nWorld = normalize((uNormalMatrix * vec4(aNormal, 0.0)).xyz);
  float ndotl = max(0.0, dot(nWorld, -normalize(uLightDirWorld)));
  float lighting = clamp(uAmbient + (1.0 - uAmbient) * ndotl, 0.0, 1.0);
  vColor = vec4(uBaseColor.rgb * lighting, uBaseColor.a);
  gl_Position = uMVP * vec4(aPosition, 1.0);
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
  uMVP: WebGLUniformLocation | null;
  uNormalMatrix: WebGLUniformLocation | null;
  uLightDirWorld: WebGLUniformLocation | null;
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
      uMVP: gl.getUniformLocation(program, "uMVP"),
      uNormalMatrix: gl.getUniformLocation(program, "uNormalMatrix"),
      uLightDirWorld: gl.getUniformLocation(program, "uLightDirWorld"),
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

export interface Geom3DRenderOptions {
  /** Proj · cameraPre · worldTransform（呼び出し側が中立性込みで合成済み）。 */
  mvp: Mat4;
  /** 法線を world 空間へ運ぶ行列（= normalMatrix(worldTransform)）。 */
  normalMatrix: Mat4;
  baseColor: readonly [number, number, number, number];
  /** comp/world 空間の平行光方向（正規化は shader 側で行う）。 */
  lightDirWorld: readonly [number, number, number];
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

  gl.uniformMatrix4fv(state.uMVP, false, opts.mvp);
  gl.uniformMatrix4fv(state.uNormalMatrix, false, opts.normalMatrix);
  gl.uniform3f(state.uLightDirWorld, opts.lightDirWorld[0], opts.lightDirWorld[1], opts.lightDirWorld[2]);
  gl.uniform1f(state.uAmbient, opts.ambient);
  gl.uniform4f(state.uBaseColor, opts.baseColor[0], opts.baseColor[1], opts.baseColor[2], opts.baseColor[3]);

  gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_INT, 0);
  return true;
}
