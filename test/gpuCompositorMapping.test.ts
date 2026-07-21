// GPU Raster Pipeline — blend id マッピングと GPU effect レジストリの純関数契約を固定する。
// shader 内 mode 分岐（分離 1..11 / 非分離 100..103 / normal 0）と 1:1 対応することを保証。

import { describe, it, expect } from "vitest";
import { blendModeToGpuId } from "../src/runtime/compositor/WebGL2Compositor";
import { isGpuEffectSupported } from "../src/runtime/compositor/gpuEffectRegistry";
import { isGpuDirectSurfaceEnabled } from "../src/runtime/compositor/gpuCompositorFlag";
import type { BlendMode } from "../src/core/schema";

describe("blendModeToGpuId", () => {
  it("normal は 0", () => {
    expect(blendModeToGpuId("normal")).toBe(0);
  });

  it("分離 blend は 1..11（重複なし）", () => {
    const separable: BlendMode[] = [
      "multiply", "screen", "overlay", "darken", "lighten",
      "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion",
    ];
    const ids = separable.map(blendModeToGpuId);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("非分離 blend は 100..103（shader の uMode>=100 分岐と一致）", () => {
    expect(blendModeToGpuId("hue")).toBe(100);
    expect(blendModeToGpuId("saturation")).toBe(101);
    expect(blendModeToGpuId("color")).toBe(102);
    expect(blendModeToGpuId("luminosity")).toBe(103);
  });
});

describe("isGpuEffectSupported", () => {
  it("mosaic は GPU pass あり", () => {
    expect(isGpuEffectSupported("mosaic")).toBe(true);
  });

  it("GPU pass 未実装の effect は false（chain 全落ちで CPU bridge・§7 案A）", () => {
    for (const t of ["wave", "ripple", "turbulentDisplace", "pixelSorter", "blur", "tint", "unknown"]) {
      expect(isGpuEffectSupported(t)).toBe(false);
    }
  });
});

describe("isGpuDirectSurfaceEnabled", () => {
  it("既定 true、bench が false を明示したときだけ従来 copy に戻す", () => {
    const g = globalThis as { __mafterGpuDirectSurface?: unknown };
    const previous = g.__mafterGpuDirectSurface;
    try {
      delete g.__mafterGpuDirectSurface;
      expect(isGpuDirectSurfaceEnabled()).toBe(true);
      g.__mafterGpuDirectSurface = false;
      expect(isGpuDirectSurfaceEnabled()).toBe(false);
      g.__mafterGpuDirectSurface = true;
      expect(isGpuDirectSurfaceEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete g.__mafterGpuDirectSurface;
      else g.__mafterGpuDirectSurface = previous;
    }
  });
});
