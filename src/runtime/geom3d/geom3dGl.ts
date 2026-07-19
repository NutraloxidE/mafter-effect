import type { Mat4 } from "../mat4";
import { isGpuMeshCacheEnabled } from "./geom3dCacheFlags";
import { MeshBufferCache, type MeshBufferStats } from "./geom3dMeshBufferCache";
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
  /**
   * 直前にアップロードした mesh の参照。同一参照ならバッファ再アップロードをスキップ。
   * ponytail: 1 canvas = 1 mesh 前提の 1 スロットキャッシュ。§5.5f-1 の共有 canvas に
   * 複数レイヤーが描くとフレームごとに全メッシュを再アップロードする（グループを組んだときだけ
   * 効かない）。__mafterGpuMeshCache ON のときは `meshCache`（複数 VBO 常駐）が担う（§8 Phase 3）。
   */
  lastMesh: MeshData | null;
  /**
   * §8 Phase 3: mesh identity ごとの GPU buffer 常駐 cache（flag ON のときのみ遅延生成）。
   * flag OFF なら null のまま = 従来 1-slot 経路（挙動不変）。
   */
  meshCache: MeshBufferCache | null;
  broken: boolean;
}

// §8 Phase 3: per-context GPU buffer 予算（runtime-only）。text mesh は 1 文字あたり数千頂点になりうるため
// 45 文字級でも収まるよう 64MB。超過時は LRU eviction で deleteBuffer。
const GPU_MESH_BUDGET_BYTES = 64 * 1024 * 1024;

const glStats: MeshBufferStats = { bufferUploads: 0 };

/** 累積 `bufferData` 呼び出し回数（ON/OFF 両経路を計上）。op-count ゲート用（warm frame で増分 0）。 */
export function geom3DGlBufferUploadCount(): number {
  return glStats.bufferUploads;
}

export function resetGeom3DGlBufferUploadCount(): void {
  glStats.bufferUploads = 0;
}

const statesByCanvas = new WeakMap<HTMLCanvasElement, Geom3DGlState>();
const contextEpochCanvases = new WeakSet<HTMLCanvasElement>();
let contextEpoch = 0;

/** Nested same-frame reuse invalidation source for WebGL context loss/restore. */
export function geom3DGlContextEpoch(): number {
  return contextEpoch;
}

/**
 * **GL context 数の上限に注意（§5.5f 既知のリスク・2026-07-16）**
 *
 * Chrome の同時 WebGL context は **1 ドキュメント ~16** が上限。超えると
 * `Too many active WebGL contexts. Oldest context will be lost.` を出して**古い context から
 * 黙って破棄する**＝先に描いたレイヤーの絵が消える（例外は飛ばない）。**上限はページ全体で共有**で、
 * split/packed alpha 合成（`videoAlphaGl.ts`・`MAX_GL_ALPHA_CONTEXTS = 8` の予算あり）とも食い合う。
 *
 * ここは **per-layer に 1 context を予算なしで作る**（3D text レイヤーを積むほど無制限に増える）。
 * 大量の 3D text ＋ alpha 動画を併用すると上限に届きうる — 必要になったら
 * `shouldCreateGlAlphaCompositor()` と同型の予算ロジック＋2D フォールバックをここにも入れる。
 *
 * 使い終わった canvas は必ず `releaseGeom3DGl()`（DOM 配下一括なら
 * `DomRenderer.releaseAlphaGlCompositorsUnder()`）で明示解放する。**canvas を DOM から
 * 外すだけでは解放されない**（context は canvas 要素に紐づき GC 待ちになる）。毎フレーム
 * canvas を作り直す実装は数十フレームで上限に達する（§23.3e のネスト comp が実例）。
 */
function createState(canvas: HTMLCanvasElement): Geom3DGlState | null {
  if (!contextEpochCanvases.has(canvas)) {
    canvas.addEventListener("webglcontextlost", () => { contextEpoch++; });
    canvas.addEventListener("webglcontextrestored", () => { contextEpoch++; });
    contextEpochCanvases.add(canvas);
  }
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
      meshCache: null,
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
  state.meshCache?.dispose(gl); // §8: 常駐 GPU buffer を全解放
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
  /**
   * §5.5f-1 canvas 共有: false なら color/depth を消さずに追記する。グループ内で**最初に描く
   * （= 最下位の）メンバーだけ true** にすること。depth buffer を残すことで 3D レイヤー同士が
   * 正しく相互貫入する。省略時は true（共有なしの従来 per-layer 挙動）。
   */
  clear?: boolean;
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
  if (opts.clear !== false) {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  if (mesh.triangleCount === 0) return true;

  gl.useProgram(state.program);

  // 使う VBO を決める。§8 Phase 3 の常駐 cache（flag ON）か、従来 1-slot（flag OFF・挙動不変）か。
  let positionBuffer: WebGLBuffer;
  let normalBuffer: WebGLBuffer;
  let indexBuffer: WebGLBuffer;
  if (isGpuMeshCacheEnabled()) {
    if (!state.meshCache) state.meshCache = new MeshBufferCache(GPU_MESH_BUDGET_BYTES);
    const buffers = state.meshCache.getOrUpload(gl, mesh, glStats);
    if (!buffers) return false; // 生成失敗 → 呼び出し側フォールバック（誤 hit を作らない）
    positionBuffer = buffers.position;
    normalBuffer = buffers.normal;
    indexBuffer = buffers.index;
  } else {
    positionBuffer = state.positionBuffer;
    normalBuffer = state.normalBuffer;
    indexBuffer = state.indexBuffer;
    if (state.lastMesh !== mesh) {
      gl.bindBuffer(gl.ARRAY_BUFFER, state.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, state.normalBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
      glStats.bufferUploads += 3;
      state.lastMesh = mesh;
    }
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.enableVertexAttribArray(state.aPosition);
  gl.vertexAttribPointer(state.aPosition, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
  gl.enableVertexAttribArray(state.aNormal);
  gl.vertexAttribPointer(state.aNormal, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

  gl.uniformMatrix4fv(state.uMVP, false, opts.mvp);
  gl.uniformMatrix4fv(state.uNormalMatrix, false, opts.normalMatrix);
  gl.uniform3f(state.uLightDirWorld, opts.lightDirWorld[0], opts.lightDirWorld[1], opts.lightDirWorld[2]);
  gl.uniform1f(state.uAmbient, opts.ambient);
  gl.uniform4f(state.uBaseColor, opts.baseColor[0], opts.baseColor[1], opts.baseColor[2], opts.baseColor[3]);

  gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_INT, 0);
  return true;
}
