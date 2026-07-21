// GPU Raster Pipeline — Phase 2 feature flag & capability。
//
// 既定は OFF（Canvas2DCompositor）。flag ON かつ WebGL2 が使える環境でのみ WebGL2 backend を試す。
// flag は **非直列化の実行時フラグ**（project.json に保存しない・INV 非関与）。dev/bench 用。
//
//   globalThis.__mafterGpuCompositor = true   // 有効化
//   globalThis.__mafterGpuDirectSurface = false // bench で従来の Canvas2D 最終コピーを強制
//
// 非対応・未指定なら常に CPU 経路（挙動不変）。

let webgl2Support: boolean | null = null;

/** WebGL2 が生成可能か（1 回だけ判定してキャッシュ）。 */
export function isWebGl2Capable(): boolean {
  if (webgl2Support !== null) return webgl2Support;
  try {
    if (typeof document === "undefined") return (webgl2Support = false);
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    webgl2Support = !!gl;
    // 判定用 context は破棄（budget を食わない）。
    const lose = gl?.getExtension("WEBGL_lose_context");
    lose?.loseContext();
  } catch {
    webgl2Support = false;
  }
  return webgl2Support;
}

/** GPU compositor を使うべきか（flag ON かつ WebGL2 対応）。既定 false。 */
export function isGpuCompositorEnabled(): boolean {
  const g = globalThis as { __mafterGpuCompositor?: unknown };
  return g.__mafterGpuCompositor === true && isWebGl2Capable();
}

/** 非透過 video encode への WebGL surface 直結。false 明示時だけ従来 copy（A/B bench 用）。 */
export function isGpuDirectSurfaceEnabled(): boolean {
  const g = globalThis as { __mafterGpuDirectSurface?: unknown };
  return g.__mafterGpuDirectSurface !== false;
}

/** テスト用: capability キャッシュをリセット。 */
export function __resetWebGl2CapabilityCache(): void {
  webgl2Support = null;
}
