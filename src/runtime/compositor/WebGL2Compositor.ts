// GPU Raster Pipeline — Phase 2: WebGL2 normal-composite backend。
//
// スコープ（意図的に限定）:
//   - normal（source-over）z 順累積のみ GPU。非 normal blend / adjustment は **非対応**として
//     throw し、呼び出し側（compositeExportFrame）がフレーム単位で Canvas2DCompositor へ fallback する。
//   - matte は capture 段階で焼き込み済み（§5.4f）なので compositor の責務外。
//   - capture（foreignObject / perspective / nested）は据置き。ここは「合成」だけ。
//
// 設計:
//   - context は **プロセス単位で 1 つ**（module singleton）。レイヤー数に比例して増えない
//     （plan §8.1・受け入れ §6）。context lost / 生成失敗は capability=false 扱いで CPU へ。
//   - 現状トップレベル compositeExportFrame でのみ使用し、nested（compositeContainer）は
//     Canvas2D のまま。そのため **同時に活きる WebGL2Compositor は 1 つ**。再入は guard で弾く
//     （2 つ目は throw → CPU fallback）。将来 nested を GPU 化する際は per-instance FBO へ拡張する。
//   - straight-alpha のレイヤ canvas を UNPACK_PREMULTIPLY_ALPHA で premultiplied texture 化し、
//     blendFunc(ONE, ONE_MINUS_SRC_ALPHA) で premultiplied source-over 累積。canvas は
//     premultipliedAlpha:true。finish で 2D canvas に drawImage（premultiplied→straight 変換は
//     ブラウザが行う）＝ Canvas2D drawImage と同じ合成結果に許容差内で一致（parity harness で検証）。

import type { BlendMode } from "../../core/schema";
import type { ExportChain } from "../exportComposite";
import type { RasterCompositor } from "./RasterCompositor";

const VERTEX_SRC = `#version 300 es
in vec2 aPos;
in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 fragColor;
void main() {
  // texture は UNPACK_PREMULTIPLY_ALPHA で premultiplied。そのまま出力し、
  // blendFunc(ONE, ONE_MINUS_SRC_ALPHA) で source-over 累積する。
  fragColor = texture(uTex, vUv);
}`;

interface GlState {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  quad: WebGLBuffer;
  tex: WebGLTexture;
  aPos: number;
  aUv: number;
  uTex: WebGLLocation | null;
  broken: boolean;
}
type WebGLLocation = WebGLUniformLocation;

let state: GlState | null = null;
let inUse = false;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("compositor shader compile failed: " + (gl.getShaderInfoLog(sh) ?? ""));
  }
  return sh;
}

function ensureState(): GlState | null {
  if (state && !state.broken) return state;
  if (state && state.broken) disposeState();
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) return null;
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SRC));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error("compositor program link failed: " + (gl.getProgramInfoLog(program) ?? ""));
    }
    const quad = gl.createBuffer();
    const tex = gl.createTexture();
    if (!quad || !tex) return null;
    // interleaved [aPos.xy, aUv.xy] × 4（triangle strip・正立クアッド）。
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 0,
      1, -1, 1, 0,
      -1, 1, 0, 1,
      1, 1, 1, 1,
    ]), gl.STATIC_DRAW);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    const s: GlState = {
      canvas, gl, program, quad, tex,
      aPos: gl.getAttribLocation(program, "aPos"),
      aUv: gl.getAttribLocation(program, "aUv"),
      uTex: gl.getUniformLocation(program, "uTex"),
      broken: false,
    };
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); s.broken = true; });
    state = s;
    return s;
  } catch {
    return null;
  }
}

function disposeState(): void {
  if (!state) return;
  try {
    const { gl } = state;
    gl.deleteBuffer(state.quad);
    gl.deleteTexture(state.tex);
    gl.deleteProgram(state.program);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch { /* noop */ }
  state = null;
}

/** WebGL2 backend が今このフレームで使えるか（context 準備 + 未使用）。 */
export function canUseWebGl2Compositor(): boolean {
  if (inUse) return false;
  return ensureState() !== null;
}

/**
 * normal-composite 専用の WebGL2 backend。非 normal blend / adjustment は throw（呼び出し側が
 * フレーム単位で Canvas2D へ fallback する）。construct → drawLayer* → finish の 1 パスのみ想定。
 */
export class WebGl2Compositor implements RasterCompositor {
  private readonly s: GlState;
  private readonly nw: number;
  private readonly nh: number;
  private done = false;

  constructor(nw: number, nh: number, bg: string) {
    const s = ensureState();
    if (!s) throw new Error("WebGl2Compositor: no GL context");
    if (inUse) throw new Error("WebGl2Compositor: re-entrant use unsupported (Phase 2)");
    inUse = true;
    this.s = s;
    this.nw = nw;
    this.nh = nh;
    const { gl, canvas } = s;
    canvas.width = nw;
    canvas.height = nh;
    gl.viewport(0, 0, nw, nh);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    // premultiplied source-over。
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const [r, g, b, a] = parseBg(bg);
    // clearColor は premultiplied 前提（背景は不透明 or 完全透明のみ想定）。
    gl.clearColor(r * a, g * a, b * a, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  drawLayer(sub: HTMLCanvasElement, blendMode: BlendMode): void {
    if (blendMode !== "normal") throw new Error("WebGl2Compositor: non-normal blend unsupported (Phase 2)");
    if (sub.width === 0 || sub.height === 0) return;
    const { gl, program, quad, tex, aPos, aUv, uTex } = this.s;
    gl.useProgram(program);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sub);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(uTex, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  applyAdjustment(_chain: ExportChain, _nw: number, _nh: number): Promise<void> {
    throw new Error("WebGl2Compositor: adjustment unsupported (Phase 2)");
  }

  finish(): HTMLCanvasElement {
    if (this.done) throw new Error("WebGl2Compositor: finish already called");
    this.done = true;
    try {
      const { gl, canvas } = this.s;
      gl.flush();
      const out = document.createElement("canvas");
      out.width = this.nw;
      out.height = this.nh;
      // premultiplied な GL canvas を 2D canvas へ drawImage → straight alpha へ変換（ブラウザ処理）。
      out.getContext("2d")!.drawImage(canvas, 0, 0);
      // dev/bench 用: GPU 経路が実際に走ったフレーム数（描画・INV に無関係）。
      const g = globalThis as { __mafterGpuCompositorFrames?: number };
      g.__mafterGpuCompositorFrames = (g.__mafterGpuCompositorFrames ?? 0) + 1;
      return out;
    } finally {
      inUse = false;
    }
  }

  /** finish 前に例外離脱したときのロック解放（呼び出し側の catch で使用）。 */
  static releaseLock(): void {
    inUse = false;
  }
}

/** "transparent" | "#rrggbb" | "rgb(...)" を [r,g,b,a] 0..1 に。未知は透明。 */
function parseBg(bg: string): [number, number, number, number] {
  if (!bg || bg === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{6})$/i.exec(bg);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  }
  const rgb = /rgba?\(([^)]+)\)/i.exec(bg);
  if (rgb) {
    const p = rgb[1]!.split(",").map((x) => parseFloat(x.trim()));
    return [(p[0] ?? 0) / 255, (p[1] ?? 0) / 255, (p[2] ?? 0) / 255, p[3] ?? 1];
  }
  return [0, 0, 0, 0];
}
