// GPU Raster Pipeline — Phase 2/3: WebGL2 合成 backend。
//
// スコープ:
//   - Phase 2: normal（source-over）z 順累積のみ GPU（fixed-function blendFunc・default FB 直書き）。
//   - Phase 3a: 非 normal の 15 CSS mix-blend-mode を ping-pong FBO の blend shader で GPU 化。
//     adjustment（調整レイヤー）は **非対応**として throw し、呼び出し側（compositeExportFrame）が
//     フレーム単位で Canvas2DCompositor へ fallback する（当面 CPU bridge）。
//   - matte は capture 段階で焼き込み済み（§5.4f）なので compositor の責務外。
//   - capture（foreignObject / perspective / nested）は据置き。ここは「合成」だけ。
//
// 設計:
//   - context は **プロセス単位で 1 つ**（module singleton）。レイヤー数に比例して増えない
//     （plan §8.1・受け入れ §6）。context lost / 生成失敗は capability=false 扱いで CPU へ。
//   - 同時に活きる WebGl2Compositor は 1 つ（nested は Canvas2D のまま）。再入は guard で弾く。
//   - alpha 規約:
//     * normal 高速パス: straight-alpha レイヤ canvas を UNPACK_PREMULTIPLY_ALPHA で premultiplied
//       texture 化 → blendFunc(ONE, ONE_MINUS_SRC_ALPHA) で source-over 累積（Phase 2・byte 一致検証済）。
//     * blend パス: レイヤ canvas は **straight** で upload、accumulator FBO は **premultiplied** RGBA8。
//       W3C Compositing & Blending の式（B(Cb,Cs) → csb=(1-αb)Cs+αb·B → source-over）を fragment で
//       明示計算。sRGB 空間のまま（linear 変換しない）＝ Canvas2D globalCompositeOperation と許容差内一致。
//       背景が不透明な comp では中間 alpha=1 のため premultiplied round-trip の精度損失は生じない。

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

// normal 高速パス（premultiplied texture の passthrough）。blend パスの最終 blit にも流用。
const FRAGMENT_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 fragColor;
void main() {
  fragColor = texture(uTex, vUv);
}`;

// blend パス: backdrop（premultiplied）と source（straight）から W3C 合成式で premultiplied 出力。
const BLEND_FRAGMENT_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uBackdrop;  // premultiplied accumulator
uniform sampler2D uSrc;       // straight-alpha source layer
uniform int uMode;
out vec4 fragColor;

vec3 unpremult(vec4 c) { return c.a > 0.0 ? c.rgb / c.a : vec3(0.0); }

float b_screen(float cb, float cs) { return cb + cs - cb * cs; }
float b_hardlight(float cb, float cs) {
  return cs <= 0.5 ? cb * (2.0 * cs) : b_screen(cb, 2.0 * cs - 1.0);
}
float b_softlight(float cb, float cs) {
  float d = cb <= 0.25 ? ((16.0 * cb - 12.0) * cb + 4.0) * cb : sqrt(cb);
  return cs <= 0.5 ? cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)
                   : cb + (2.0 * cs - 1.0) * (d - cb);
}
float b_colordodge(float cb, float cs) {
  if (cb == 0.0) return 0.0;
  if (cs >= 1.0) return 1.0;
  return min(1.0, cb / (1.0 - cs));
}
float b_colorburn(float cb, float cs) {
  if (cb >= 1.0) return 1.0;
  if (cs == 0.0) return 0.0;
  return 1.0 - min(1.0, (1.0 - cb) / cs);
}
float sepChannel(int mode, float cb, float cs) {
  if (mode == 1) return cb * cs;                 // multiply
  if (mode == 2) return b_screen(cb, cs);        // screen
  if (mode == 3) return b_hardlight(cs, cb);     // overlay = hardlight(cs, cb)
  if (mode == 4) return min(cb, cs);             // darken
  if (mode == 5) return max(cb, cs);             // lighten
  if (mode == 6) return b_colordodge(cb, cs);    // color-dodge
  if (mode == 7) return b_colorburn(cb, cs);     // color-burn
  if (mode == 8) return b_hardlight(cb, cs);     // hard-light
  if (mode == 9) return b_softlight(cb, cs);     // soft-light
  if (mode == 10) return abs(cb - cs);           // difference
  if (mode == 11) return cb + cs - 2.0 * cb * cs; // exclusion
  return cs;                                     // normal
}

// 非分離 blend（hue/saturation/color/luminosity）— W3C の Lum/Sat 操作。
float lum(vec3 c) { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
// SetSat: 線形写像 (c-min)*s/(max-min) が W3C の min→0 / mid→(mid-min)s/(max-min) / max→s と一致。
vec3 setSat(vec3 c, float s) {
  float mn = min(min(c.r, c.g), c.b);
  float mx = max(max(c.r, c.g), c.b);
  float d = mx - mn;
  return d > 0.0 ? (c - mn) * s / d : vec3(0.0);
}

void main() {
  vec4 bpm = texture(uBackdrop, vUv);   // premultiplied backdrop
  float ab = bpm.a;
  vec3 cb = unpremult(bpm);
  vec4 s = texture(uSrc, vUv);          // straight source
  float as = s.a;
  vec3 cs = s.rgb;
  vec3 B;
  if (uMode >= 100) {
    if (uMode == 100) B = setLum(setSat(cs, sat(cb)), lum(cb));      // hue
    else if (uMode == 101) B = setLum(setSat(cb, sat(cs)), lum(cb)); // saturation
    else if (uMode == 102) B = setLum(cs, lum(cb));                 // color
    else B = setLum(cb, lum(cs));                                   // luminosity
  } else {
    B = vec3(sepChannel(uMode, cb.r, cs.r),
             sepChannel(uMode, cb.g, cs.g),
             sepChannel(uMode, cb.b, cs.b));
  }
  vec3 csb = mix(cs, B, ab);                        // (1-ab)*Cs + ab*B
  vec3 co = as * csb + bpm.rgb * (1.0 - as);        // premultiplied source-over
  float ao = as + ab * (1.0 - as);
  fragColor = vec4(co, ao);
}`;

/** blendMode を blend shader の mode id へ。normal=0 / 分離 1..11 / 非分離 100..103。 */
export function blendModeToGpuId(mode: BlendMode): number {
  switch (mode) {
    case "multiply": return 1;
    case "screen": return 2;
    case "overlay": return 3;
    case "darken": return 4;
    case "lighten": return 5;
    case "color-dodge": return 6;
    case "color-burn": return 7;
    case "hard-light": return 8;
    case "soft-light": return 9;
    case "difference": return 10;
    case "exclusion": return 11;
    case "hue": return 100;
    case "saturation": return 101;
    case "color": return 102;
    case "luminosity": return 103;
    default: return 0; // normal
  }
}

type WebGLLocation = WebGLUniformLocation;

interface BlendState {
  program: WebGLProgram;
  srcTex: WebGLTexture;
  // ping-pong accumulator（premultiplied RGBA8）。
  tex: [WebGLTexture, WebGLTexture];
  fbo: [WebGLFramebuffer, WebGLFramebuffer];
  allocW: number;
  allocH: number;
  aPos: number;
  aUv: number;
  uBackdrop: WebGLLocation | null;
  uSrc: WebGLLocation | null;
  uMode: WebGLLocation | null;
}

interface GlState {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  quad: WebGLBuffer;
  tex: WebGLTexture;
  aPos: number;
  aUv: number;
  uTex: WebGLLocation | null;
  blend: BlendState | null;
  broken: boolean;
}

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

function linkProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error("compositor program link failed: " + (gl.getProgramInfoLog(program) ?? ""));
  }
  return program;
}

function makeAccumTexture(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
  const t = gl.createTexture();
  if (!t) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return t;
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
    const program = linkProgram(gl, VERTEX_SRC, FRAGMENT_SRC);
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
      blend: null,
      broken: false,
    };
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); s.broken = true; });
    state = s;
    return s;
  } catch {
    return null;
  }
}

/** blend パス用リソース（program / src texture / ping-pong FBO）を必要時に確保・リサイズする。 */
function ensureBlendState(s: GlState, nw: number, nh: number): BlendState {
  const { gl } = s;
  if (!s.blend) {
    const program = linkProgram(gl, VERTEX_SRC, BLEND_FRAGMENT_SRC);
    const srcTex = gl.createTexture();
    if (!srcTex) throw new Error("createTexture(src) failed");
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    s.blend = {
      program, srcTex,
      tex: [gl.createTexture()!, gl.createTexture()!], // 下で allocate
      fbo: [gl.createFramebuffer()!, gl.createFramebuffer()!],
      allocW: 0, allocH: 0,
      aPos: gl.getAttribLocation(program, "aPos"),
      aUv: gl.getAttribLocation(program, "aUv"),
      uBackdrop: gl.getUniformLocation(program, "uBackdrop"),
      uSrc: gl.getUniformLocation(program, "uSrc"),
      uMode: gl.getUniformLocation(program, "uMode"),
    };
  }
  const b = s.blend;
  if (b.allocW !== nw || b.allocH !== nh) {
    for (let i = 0; i < 2; i++) {
      gl.deleteTexture(b.tex[i]!);
      b.tex[i] = makeAccumTexture(gl, nw, nh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo[i]!);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, b.tex[i]!, 0);
    }
    b.allocW = nw;
    b.allocH = nh;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  return b;
}

function disposeState(): void {
  if (!state) return;
  try {
    const { gl } = state;
    gl.deleteBuffer(state.quad);
    gl.deleteTexture(state.tex);
    gl.deleteProgram(state.program);
    if (state.blend) {
      gl.deleteProgram(state.blend.program);
      gl.deleteTexture(state.blend.srcTex);
      gl.deleteTexture(state.blend.tex[0]);
      gl.deleteTexture(state.blend.tex[1]);
      gl.deleteFramebuffer(state.blend.fbo[0]);
      gl.deleteFramebuffer(state.blend.fbo[1]);
    }
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
 * WebGL2 合成 backend。construct → drawLayer*（全 normal）または drawLayerBlend*（blend 混在）→ finish
 * の 1 パスを想定。normal 高速パスと blend ping-pong パスは 1 フレーム内で混用しない（呼び出し側が
 * フレーム単位でどちらかを選ぶ）。adjustment は throw（呼び出し側が Canvas2D へ fallback）。
 */
export class WebGl2Compositor implements RasterCompositor {
  private readonly s: GlState;
  private readonly nw: number;
  private readonly nh: number;
  private readonly bgPremult: [number, number, number, number];
  private done = false;
  private blendUsed = false;
  private blendReadIdx = 0;

  constructor(nw: number, nh: number, bg: string) {
    const s = ensureState();
    if (!s) throw new Error("WebGl2Compositor: no GL context");
    if (inUse) throw new Error("WebGl2Compositor: re-entrant use unsupported");
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
    // premultiplied source-over（normal 高速パス用）。
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const [r, g, b, a] = parseBg(bg);
    this.bgPremult = [r * a, g * a, b * a, a];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(this.bgPremult[0], this.bgPremult[1], this.bgPremult[2], this.bgPremult[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** normal 高速パス（Phase 2・byte 一致検証済）。default FB へ fixed-function source-over 累積。 */
  drawLayer(sub: HTMLCanvasElement, blendMode: BlendMode): void {
    if (blendMode !== "normal") throw new Error("WebGl2Compositor.drawLayer: non-normal blend requires drawLayerBlend");
    if (this.blendUsed) throw new Error("WebGl2Compositor: cannot mix normal fast path with blend path");
    if (sub.width === 0 || sub.height === 0) return;
    const { gl, program, tex, aPos, aUv, uTex } = this.s;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sub);
    gl.uniform1i(uTex, 0);
    this.bindQuad(aPos, aUv);
    gl.enable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * blend パス（Phase 3a）。ping-pong FBO で W3C 合成式を shader 実行。normal も mode=0 として本パスで
   * 扱えるので、非 normal blend を1つでも含むフレームは全レイヤを本メソッドで流す。
   */
  drawLayerBlend(sub: HTMLCanvasElement, blendMode: BlendMode): void {
    if (this.done) throw new Error("WebGl2Compositor: finish already called");
    const { gl } = this.s;
    const b = ensureBlendState(this.s, this.nw, this.nh);
    if (!this.blendUsed) {
      // 初回: 読み側 accumulator を背景 premultiplied で clear。
      this.blendReadIdx = 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo[0]!);
      gl.disable(gl.BLEND);
      gl.clearColor(this.bgPremult[0], this.bgPremult[1], this.bgPremult[2], this.bgPremult[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.blendUsed = true;
    }
    if (sub.width === 0 || sub.height === 0) return;

    const readIdx = this.blendReadIdx;
    const writeIdx = 1 - readIdx;
    // source を straight-alpha で upload。
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, b.srcTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sub);

    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo[writeIdx]!);
    gl.viewport(0, 0, this.nw, this.nh);
    gl.disable(gl.BLEND); // shader が完全な合成結果を書くので fixed-function blend は使わない。
    gl.useProgram(b.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, b.tex[readIdx]!);
    gl.uniform1i(b.uBackdrop, 0);
    gl.uniform1i(b.uSrc, 1);
    gl.uniform1i(b.uMode, blendModeToGpuId(blendMode));
    this.bindQuad(b.aPos, b.aUv);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.blendReadIdx = writeIdx;
  }

  private bindQuad(aPos: number, aUv: number): void {
    const { gl, quad } = this.s;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
  }

  applyAdjustment(_chain: ExportChain, _nw: number, _nh: number): Promise<void> {
    throw new Error("WebGl2Compositor: adjustment unsupported (CPU bridge)");
  }

  finish(): HTMLCanvasElement {
    if (this.done) throw new Error("WebGl2Compositor: finish already called");
    this.done = true;
    try {
      const { gl, canvas } = this.s;
      if (this.blendUsed) {
        // 最終 accumulator（premultiplied）を default FB に passthrough で blit（blend 無効 = 置換）。
        const b = this.s.blend!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.nw, this.nh);
        gl.disable(gl.BLEND);
        gl.useProgram(this.s.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, b.tex[this.blendReadIdx]!);
        gl.uniform1i(this.s.uTex, 0);
        this.bindQuad(this.s.aPos, this.s.aUv);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
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
