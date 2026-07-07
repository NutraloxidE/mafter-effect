/**
 * §16.2 プランv2 §2.1 — split/packed alpha 合成を CPU（`getImageData`/`putImageData`）ではなく
 * WebGL1 のシェーダで行うための compositor。THREE.js 不使用・「canvas のピクセルを作る手段」以外の
 * 用途は持たない（DOM のレイヤー構造・matrix3d・blend/filter には一切関与しない）。
 */

export interface PackedAlphaLayout {
  /** color/mask 各段の高さ（px）。packed 動画の総高さは概ね 2*contentHeight + gutterPx。 */
  contentHeight: number;
  /** color/mask 境界のクロマにじみ防止用ガター（px）。 */
  gutterPx: number;
}

export interface GlAlphaCompositor {
  /** drawSplitAlphaComposite と同じ契約: 両ソース ready なら描画して true。 */
  compositeSplit(colorVideo: HTMLVideoElement, alphaVideo: HTMLVideoElement): boolean;
  /** packed 1本: 上半分=color, 下半分=mask を UV で振り分けて合成。 */
  compositePacked(packedVideo: HTMLVideoElement, layout: PackedAlphaLayout): boolean;
  /** context lost 等で使用不能になったら true（呼び出し側は CPU 経路へフォールバック）。 */
  readonly broken: boolean;
  dispose(): void;
}

const VERTEX_SRC = `
attribute vec2 aPosition;
attribute vec2 aUv;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

// §1.2 反転教訓: UNPACK_FLIP_Y_WEBGL を有効にして UV は素直に書く（row0=v0 が正立画像の上端になる）。
const SPLIT_FRAGMENT_SRC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uColor;
uniform sampler2D uMask;
void main() {
  vec4 color = texture2D(uColor, vUv);
  vec4 mask = texture2D(uMask, vUv);
  // applyGrayscaleMaskToAlphaChannel（CPU 実装）と同じくストレートアルファ（RGB は据え置き、
  // alpha だけ mask.r に差し替え）。premultiplied にすると partial-alpha 境界で
  // premultiply→unpremultiply の往復量子化により CPU 経路と数 LSB のズレが出るため避ける。
  gl_FragColor = vec4(color.rgb, mask.r);
}
`;

// §2.2 上下パック: 上段=color, 下段=mask（gutter を挟む）。vUv.y は宛先（content 高さ）内の 0..1。
const PACKED_FRAGMENT_SRC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uPacked;
uniform float uContentHeightNorm;
uniform float uGutterNorm;
void main() {
  vec2 colorUv = vec2(vUv.x, vUv.y * uContentHeightNorm);
  vec2 maskUv = vec2(vUv.x, uContentHeightNorm + uGutterNorm + vUv.y * uContentHeightNorm);
  vec4 color = texture2D(uPacked, colorUv);
  vec4 mask = texture2D(uPacked, maskUv);
  // split 版と同じ理由でストレートアルファ。
  gl_FragColor = vec4(color.rgb, mask.r);
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
    throw new Error(`shader compile failed: ${info ?? "unknown"}`);
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
    throw new Error(`program link failed: ${info ?? "unknown"}`);
  }
  return program;
}

function isVideoReadyForGl(video: HTMLVideoElement): boolean {
  return (
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  );
}

/**
 * 予算・キルスイッチ判定の純ロジック（DOM/GL に触れない）。呼び出し側が
 * 「既に compositor を持っているか」「予算に空きがあるか」「キルスイッチが有効か」を渡す。
 */
export function shouldCreateGlAlphaCompositor(params: {
  alreadyHasCompositor: boolean;
  activeCount: number;
  maxContexts: number;
  killSwitchActive: boolean;
}): boolean {
  if (params.alreadyHasCompositor) return false;
  if (params.killSwitchActive) return false;
  return params.activeCount < params.maxContexts;
}

/**
 * GL 経路を使うか CPU フォールバックか、の分岐だけを切り出した純ロジック。
 * `gl` が非 null かつ `broken` でないときだけ GL 側 thunk を呼ぶ。
 */
export function dispatchSplitAlphaComposite(
  gl: GlAlphaCompositor | null | undefined,
  compositeGl: () => boolean,
  compositeCpu: () => boolean,
): boolean {
  if (gl && !gl.broken) return compositeGl();
  return compositeCpu();
}

export function createGlAlphaCompositor(canvas: HTMLCanvasElement): GlAlphaCompositor | null {
  let gl: WebGLRenderingContext | null;
  try {
    gl = canvas.getContext("webgl", {
      alpha: true,
      // ストレートアルファ出力（CPU 実装と一致）に合わせ、canvas 側にも premultiply させない。
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
    });
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const ctx = gl;

  let broken = false;
  const onContextLost = (e: Event): void => {
    e.preventDefault();
    broken = true;
  };
  canvas.addEventListener("webglcontextlost", onContextLost);

  let splitProgram: WebGLProgram;
  let packedProgram: WebGLProgram;
  try {
    splitProgram = linkProgram(ctx, VERTEX_SRC, SPLIT_FRAGMENT_SRC);
    packedProgram = linkProgram(ctx, VERTEX_SRC, PACKED_FRAGMENT_SRC);
  } catch {
    canvas.removeEventListener("webglcontextlost", onContextLost);
    return null;
  }

  // location はリンク後不変。毎 composite 呼び出しで getAttribLocation/getUniformLocation を
  // 引き直すのはホットパスの無駄なので、プログラムごとに一度だけ引いてキャッシュする。
  const splitLoc = {
    aPosition: ctx.getAttribLocation(splitProgram, "aPosition"),
    aUv: ctx.getAttribLocation(splitProgram, "aUv"),
    uColor: ctx.getUniformLocation(splitProgram, "uColor"),
    uMask: ctx.getUniformLocation(splitProgram, "uMask"),
  };
  const packedLoc = {
    aPosition: ctx.getAttribLocation(packedProgram, "aPosition"),
    aUv: ctx.getAttribLocation(packedProgram, "aUv"),
    uPacked: ctx.getUniformLocation(packedProgram, "uPacked"),
    uContentHeightNorm: ctx.getUniformLocation(packedProgram, "uContentHeightNorm"),
    uGutterNorm: ctx.getUniformLocation(packedProgram, "uGutterNorm"),
  };

  const quadBuffer = ctx.createBuffer();
  if (!quadBuffer) {
    canvas.removeEventListener("webglcontextlost", onContextLost);
    return null;
  }
  ctx.bindBuffer(ctx.ARRAY_BUFFER, quadBuffer);
  // interleaved [aPosition.xy, aUv.xy] x4（triangle strip の正立クアッド。§1.2 UV反転教訓対応）。
  ctx.bufferData(
    ctx.ARRAY_BUFFER,
    new Float32Array([
      -1, -1, 0, 0,
      1, -1, 1, 0,
      -1, 1, 0, 1,
      1, 1, 1, 1,
    ]),
    ctx.STATIC_DRAW,
  );

  function createVideoTexture(): WebGLTexture {
    const tex = ctx.createTexture();
    if (!tex) throw new Error("createTexture failed");
    ctx.bindTexture(ctx.TEXTURE_2D, tex);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);
    // 合成先 canvas は常に動画のネイティブ解像度と同一（拡縮なし）。LINEAR は 1:1 でも
    // texel 境界の半ピクセルずれで隣接テクセルを混ぜ得るため、CPU の drawImage（1:1 コピー）と
    // 一致させるには NEAREST が正しい。
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.NEAREST);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.NEAREST);
    return tex;
  }

  let colorTex: WebGLTexture;
  let maskTex: WebGLTexture;
  let packedTex: WebGLTexture;
  try {
    colorTex = createVideoTexture();
    maskTex = createVideoTexture();
    packedTex = createVideoTexture();
  } catch {
    canvas.removeEventListener("webglcontextlost", onContextLost);
    return null;
  }

  ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, true);
  ctx.pixelStorei(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  // ブラウザ既定では texImage2D(video) 時に 2D canvas の drawImage とは別経路の
  // 色空間変換が適用されることがあり、CPU 経路との数 LSB のズレの原因になりうるため無効化する。
  ctx.pixelStorei(ctx.UNPACK_COLORSPACE_CONVERSION_WEBGL, ctx.NONE);
  ctx.disable(ctx.BLEND);
  ctx.disable(ctx.DEPTH_TEST);

  function uploadVideoTexture(tex: WebGLTexture, video: HTMLVideoElement): void {
    ctx.bindTexture(ctx.TEXTURE_2D, tex);
    ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, video);
  }

  function drawQuad(
    program: WebGLProgram,
    aPosition: number,
    aUv: number,
    w: number,
    h: number,
    bindUniforms: () => void,
  ): void {
    ctx.viewport(0, 0, w, h);
    ctx.useProgram(program);
    ctx.bindBuffer(ctx.ARRAY_BUFFER, quadBuffer);
    ctx.enableVertexAttribArray(aPosition);
    ctx.vertexAttribPointer(aPosition, 2, ctx.FLOAT, false, 16, 0);
    ctx.enableVertexAttribArray(aUv);
    ctx.vertexAttribPointer(aUv, 2, ctx.FLOAT, false, 16, 8);
    ctx.clearColor(0, 0, 0, 0);
    ctx.clear(ctx.COLOR_BUFFER_BIT);
    bindUniforms();
    ctx.drawArrays(ctx.TRIANGLE_STRIP, 0, 4);
  }

  return {
    compositeSplit(colorVideo, alphaVideo) {
      if (broken) return false;
      if (!isVideoReadyForGl(colorVideo) || !isVideoReadyForGl(alphaVideo)) return false;
      const w = colorVideo.videoWidth;
      const h = colorVideo.videoHeight;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      try {
        uploadVideoTexture(colorTex, colorVideo);
        uploadVideoTexture(maskTex, alphaVideo);
        drawQuad(splitProgram, splitLoc.aPosition, splitLoc.aUv, w, h, () => {
          ctx.activeTexture(ctx.TEXTURE0);
          ctx.bindTexture(ctx.TEXTURE_2D, colorTex);
          ctx.uniform1i(splitLoc.uColor, 0);
          ctx.activeTexture(ctx.TEXTURE1);
          ctx.bindTexture(ctx.TEXTURE_2D, maskTex);
          ctx.uniform1i(splitLoc.uMask, 1);
        });
      } catch {
        broken = true;
        return false;
      }
      return true;
    },
    compositePacked(packedVideo, layout) {
      if (broken) return false;
      if (!isVideoReadyForGl(packedVideo)) return false;
      const vw = packedVideo.videoWidth;
      const vh = packedVideo.videoHeight;
      if (vh <= 0 || layout.contentHeight <= 0) return false;
      const w = vw;
      const h = layout.contentHeight;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const contentNorm = layout.contentHeight / vh;
      const gutterNorm = layout.gutterPx / vh;
      try {
        uploadVideoTexture(packedTex, packedVideo);
        drawQuad(packedProgram, packedLoc.aPosition, packedLoc.aUv, w, h, () => {
          ctx.activeTexture(ctx.TEXTURE0);
          ctx.bindTexture(ctx.TEXTURE_2D, packedTex);
          ctx.uniform1i(packedLoc.uPacked, 0);
          ctx.uniform1f(packedLoc.uContentHeightNorm, contentNorm);
          ctx.uniform1f(packedLoc.uGutterNorm, gutterNorm);
        });
      } catch {
        broken = true;
        return false;
      }
      return true;
    },
    get broken() {
      return broken;
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", onContextLost);
      try {
        ctx.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        /* best-effort */
      }
      broken = true;
    },
  };
}
