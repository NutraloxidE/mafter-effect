import { describe, expect, it } from "vitest";
import { LIQUID_CHROME_EFFECT_DEF } from "../src/runtime/fastEffects";
import {
  DISPLACEMENT_EFFECT_TYPES,
  FAST_DISPLACEMENT_EFFECT_TYPES,
  LIVE_DISPLACEMENT_EFFECT_TYPES,
  chromeStripPng,
  liquidChromePrimitives,
} from "../src/runtime/effectSvg";

const baseOpts = {
  size: 140,
  warp: 160,
  detail: 45,
  bands: 6,
  evolution: 0,
  seed: 7,
  quality: 1,
  w: 400,
  h: 300,
};

describe("chromeStripPng (pure)", () => {
  it("is deterministic and returns a raw PNG data URI", () => {
    expect(chromeStripPng(6)).toEqual(chromeStripPng(6));
    expect(chromeStripPng(6).startsWith("data:image/png;base64,")).toBe(true);
  });

  it("differs by band count", () => {
    expect(chromeStripPng(6)).not.toEqual(chromeStripPng(8));
  });
});

describe("liquidChromePrimitives (pure・fill 方式)", () => {
  it("is deterministic for the same inputs", () => {
    expect(liquidChromePrimitives(baseOpts)).toEqual(liquidChromePrimitives(baseOpts));
  });

  it("is a fill: warps a chrome strip (feImage) and confines it to SourceAlpha", () => {
    const s = liquidChromePrimitives(baseOpts);
    // 金属縞グラデを feImage で敷く（生 PNG）
    expect(s).toContain("<feImage");
    expect(s).toContain('result="stripOne"');
    // 2 段 displacement（warp 骨格 + detail curl）
    expect((s.match(/<feDisplacementMap\b/g) ?? []).length).toBe(2);
    // レイヤー形状に閉じ込め（下地の色は捨てる）
    expect(s).toContain('in2="SourceAlpha" operator="in"');
    // 旧方式の遺物が残っていないこと（作り直し回帰）
    expect(s).not.toContain("feSpecularLighting");
  });

  it("wires warp (coarse) and detail (curl) into the two displacement scales", () => {
    const s = liquidChromePrimitives({ ...baseOpts, warp: 200, detail: 55 });
    expect(s).toContain('scale="200"');
    expect(s).toContain('scale="55"');
  });

  it("quality below 0.5 drops the base turbulence to 2 octaves", () => {
    expect(liquidChromePrimitives({ ...baseOpts, quality: 1 })).toContain('numOctaves="3"');
    expect(liquidChromePrimitives({ ...baseOpts, quality: 0.2 })).toContain('numOctaves="2"');
  });

  // evolution パンの「動く四角枠」回帰防止（tile+mod 方式）。
  it("keeps the base feTurbulence generation region fixed at (0,0,w,h) regardless of evolution (no boiling)", () => {
    const region = `stitchTiles="stitch" x="0" y="0" width="${baseOpts.w}" height="${baseOpts.h}"`;
    expect(liquidChromePrimitives({ ...baseOpts, evolution: 0 })).toContain(region);
    expect(liquidChromePrimitives({ ...baseOpts, evolution: 270 })).toContain(region);
  });

  it("seamlessly tiles both the noise and the chrome strip (no rectangular frame on pan)", () => {
    const s = liquidChromePrimitives({ ...baseOpts, evolution: 90 });
    expect(s).toContain('result="noiseTiled"');
    expect(s).toContain('result="stripField"');
    expect((s.match(/<feTile\b/g) ?? []).length).toBe(2);
  });

  it("reduces the evolution offset modulo the tile size so it never runs past the tiled field", () => {
    // evolution=3600 (10 revolutions) with size=140 → 生の dist=1400px だが mod (w,h) で収まる。
    const s = liquidChromePrimitives({ ...baseOpts, evolution: 3600 });
    const m = s.match(/<feOffset[^>]*\bdx="(-?[\d.]+)"[^>]*\bdy="(-?[\d.]+)"/);
    expect(m).not.toBeNull();
    expect(Math.abs(Number(m![1]))).toBeLessThan(baseOpts.w);
    expect(Math.abs(Number(m![2]))).toBeLessThan(baseOpts.h);
  });
});

describe("liquidChrome wiring (§2.2 配線点)", () => {
  it("is registered in DISPLACEMENT_EFFECT_TYPES", () => {
    expect(DISPLACEMENT_EFFECT_TYPES.has("liquidChrome")).toBe(true);
  });
  it("is registered in FAST_DISPLACEMENT_EFFECT_TYPES", () => {
    expect(FAST_DISPLACEMENT_EFFECT_TYPES.has("liquidChrome")).toBe(true);
  });
  it("is registered in LIVE_DISPLACEMENT_EFFECT_TYPES", () => {
    expect(LIVE_DISPLACEMENT_EFFECT_TYPES.has("liquidChrome")).toBe(true);
  });
});

describe("LIQUID_CHROME_EFFECT_DEF", () => {
  const props = { size: 140, warp: 160, detail: 45, bands: 6, evolution: 0, seed: 7, quality: 1 };

  it("apply() returns an svg fill chain (feImage strip + SourceAlpha confine)", () => {
    const out = LIQUID_CHROME_EFFECT_DEF.apply(props, { width: 400, height: 300, frame: 0 });
    expect(out).not.toBeNull();
    expect(out?.kind).toBe("svg");
    if (out?.kind === "svg") {
      expect(out.primitives).toContain("<feImage");
      expect(out.primitives).toContain('in2="SourceAlpha" operator="in"');
    }
  });

  it("exposes the fill-mode params (size/warp/detail/bands/evolution/seed/quality)", () => {
    const keys = LIQUID_CHROME_EFFECT_DEF.params.map((p) => p.key);
    expect(keys).toEqual(["size", "warp", "detail", "bands", "evolution", "seed", "quality"]);
  });

  it("executionPath is live and category is スタイライズ", () => {
    expect(LIQUID_CHROME_EFFECT_DEF.executionPath).toBe("live");
    expect(LIQUID_CHROME_EFFECT_DEF.category).toBe("スタイライズ");
  });
});
