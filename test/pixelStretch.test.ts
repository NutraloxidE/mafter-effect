import { describe, expect, it } from "vitest";
import { PIXEL_STRETCH_EFFECT_DEF } from "../src/runtime/fastEffects";
import {
  DISPLACEMENT_EFFECT_TYPES,
  FAST_DISPLACEMENT_EFFECT_TYPES,
  LIVE_DISPLACEMENT_EFFECT_TYPES,
  PIXEL_STRETCH_MAX_SLICE,
  pixelStretchDisplaceMaps,
  pixelStretchPrimitives,
  type PixelStretchOpts,
} from "../src/runtime/effectSvg";
import { decodePngDataUri } from "./helpers/decodePng";

const ctx = { width: 1920, height: 1080, frame: 0 };

/**
 * feDisplacementMap 2 段チェーンのシミュレータ。
 * stage2 は stage1 出力（整数グリッドの raster）を x+δ2 で再サンプルするため、
 * 整数着地設計に合わせて round した位置の stage1 到達点を返す。
 */
function simulate(opts: PixelStretchOpts): {
  sampledAt: (i: number) => number;
  hasStage2: boolean;
} {
  const { stage1, stage2 } = pixelStretchDisplaceMaps(opts);
  const horiz = opts.direction === "right" || opts.direction === "left";
  const m1 = decodePngDataUri(stage1.uri);
  const chanOf = (m: { rgba: Uint8Array }, i: number) => m.rgba[i * 4 + (horiz ? 0 : 1)]!;
  const m2 = stage2 ? decodePngDataUri(stage2.uri) : null;
  return {
    hasStage2: stage2 !== null,
    sampledAt: (i: number) => {
      let y = i;
      if (stage2 && m2) {
        const p = i + stage2.scale * (chanOf(m2, i) / 255 - 0.5);
        y = Math.round(p);
      }
      return y + stage1.scale * (chanOf(m1, y) / 255 - 0.5);
    },
  };
}

describe("pixelStretchDisplaceMaps (pure)", () => {
  it("is deterministic for the same inputs", () => {
    const o: PixelStretchOpts = { w: 1920, h: 1080, direction: "right", linePos: 0.5, length: 300, density: 1 };
    expect(pixelStretchDisplaceMaps(o)).toEqual(pixelStretchDisplaceMaps(o));
  });

  it("returns raw PNG data URIs", () => {
    const { stage1, stage2 } = pixelStretchDisplaceMaps({ w: 800, h: 4, direction: "right", linePos: 0.5, length: 300, density: 1 });
    expect(stage1.uri.startsWith("data:image/png;base64,")).toBe(true);
    expect(stage2).not.toBeNull();
    expect(stage2!.uri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("stage1 scale is 2×length", () => {
    const { stage1 } = pixelStretchDisplaceMaps({ w: 200, h: 200, direction: "right", linePos: 0.5, length: 250, density: 1 });
    expect(stage1.scale).toBe(500);
  });

  it("density=1: every band pixel samples the source line within sub-pixel (2-stage correction)", () => {
    const w = 800;
    const length = 300; // scale1=600 > 255 → 量子化プラトーが 2.35px → stage2 必須
    const linePos = 0.25;
    const sim = simulate({ w, h: 4, direction: "right", linePos, length, density: 1 });
    expect(sim.hasStage2).toBe(true);
    const line = Math.round(linePos * w);
    let maxErr = 0;
    for (let x = line; x <= Math.min(line + length, w - 1); x++) {
      maxErr = Math.max(maxErr, Math.abs(sim.sampledAt(x) - line));
    }
    expect(maxErr).toBeLessThanOrEqual(0.75);
  });

  it("density=1, length<=127: single stage is already sub-pixel (no stage2)", () => {
    const w = 400;
    const length = 100; // scale1=200 ≤ 255
    const sim = simulate({ w, h: 4, direction: "right", linePos: 0.5, length, density: 1 });
    expect(sim.hasStage2).toBe(false);
    const line = 200;
    for (let x = line; x <= line + length; x++) {
      expect(Math.abs(sim.sampledAt(x) - line)).toBeLessThanOrEqual(0.6);
    }
  });

  it("low density: band repeats a sliceW-wide strip from the line", () => {
    const w = 800;
    const length = 300;
    const density = 0.5; // sliceW = round(0.5*64) = 32
    const sliceW = Math.round((1 - density) * PIXEL_STRETCH_MAX_SLICE);
    const sim = simulate({ w, h: 4, direction: "right", linePos: 0.25, length, density });
    const line = 200;
    let maxErr = 0;
    for (let x = line; x <= Math.min(line + length, w - 1); x++) {
      const target = line + ((x - line) % sliceW);
      maxErr = Math.max(maxErr, Math.abs(sim.sampledAt(x) - target));
    }
    expect(maxErr).toBeLessThanOrEqual(0.75);
  });

  it("left direction mirrors the band and targets", () => {
    const w = 400;
    const length = 300;
    const sim = simulate({ w, h: 4, direction: "left", linePos: 0.75, length, density: 1 });
    const line = 300;
    for (let x = Math.max(0, line - length); x <= line; x += 7) {
      expect(Math.abs(sim.sampledAt(x) - line)).toBeLessThanOrEqual(0.75);
    }
  });

  it("down direction writes the G channel and uses a 1×h buffer", () => {
    const { stage1 } = pixelStretchDisplaceMaps({ w: 300, h: 200, direction: "down", linePos: 0.25, length: 80, density: 1 });
    const { width, height, rgba } = decodePngDataUri(stage1.uri);
    expect(width).toBe(1);
    expect(height).toBe(200);
    const line = 50;
    expect(rgba[(line + 10) * 4]).toBe(128); // R neutral
    expect(rgba[(line + 10) * 4 + 1]).not.toBe(128); // G displaced
  });

  it("outside the band both stages are neutral (128)", () => {
    const { stage1, stage2 } = pixelStretchDisplaceMaps({ w: 800, h: 4, direction: "right", linePos: 0.25, length: 300, density: 1 });
    const m1 = decodePngDataUri(stage1.uri);
    const m2 = decodePngDataUri(stage2!.uri);
    for (const x of [0, 100, 195, 510, 799]) {
      expect(m1.rgba[x * 4]).toBe(128);
      expect(m2.rgba[x * 4]).toBe(128);
    }
  });

  it("horizontal output is independent of h (redundant axis collapse)", () => {
    const a = pixelStretchDisplaceMaps({ w: 640, h: 1080, direction: "right", linePos: 0.5, length: 200, density: 1 });
    const b = pixelStretchDisplaceMaps({ w: 640, h: 64, direction: "right", linePos: 0.5, length: 200, density: 1 });
    expect(a.stage1.uri).toBe(b.stage1.uri);
    expect(a.stage2?.uri).toBe(b.stage2?.uri);
  });

  it("lineBias=0 or omitted yields bit-identical maps (regression gate for no behavioral change)", () => {
    const base = { w: 800, h: 4, direction: "right" as const, linePos: 0.25, length: 300, density: 1 };
    const a = pixelStretchDisplaceMaps(base);
    const b = pixelStretchDisplaceMaps({ ...base, lineBias: 0 });
    const c = pixelStretchDisplaceMaps({ ...base, lineBias: undefined });
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  it("lineBias shifts only the sampled source position, not the band (effect) start position", () => {
    const w = 800;
    const length = 100;
    const linePos = 0.25;
    const bias = 7;
    const base = Math.round(linePos * w); // 200
    const sim = simulate({ w, h: 4, direction: "right", linePos, length, density: 1, lineBias: bias });
    // Band (effect region where stretching happens) starts at position determined by linePos only.
    // Before the band: identity (samples its own position).
    expect(Math.round(sim.sampledAt(base - 1))).toBe(base - 1);
    // At the very start of the band (effect start), it should sample from (base + bias), not base.
    expect(Math.round(sim.sampledAt(base))).toBe(base + bias);
    // Inside the band too (density=1 means constant sample).
    expect(Math.round(sim.sampledAt(base + 20))).toBe(base + bias);
    // The map should be neutral just before band start, and non-neutral at band start.
    const maps = pixelStretchDisplaceMaps({ w, h: 4, direction: "right", linePos, length, density: 1, lineBias: bias });
    const m1 = decodePngDataUri(maps.stage1.uri);
    const neutral = (x: number) => m1.rgba[x * 4 + 0] === 128;
    expect(neutral(base - 1)).toBe(true);
    expect(neutral(base)).toBe(false);
  });
});

describe("pixelStretchPrimitives", () => {
  it("emits a two-stage feDisplacementMap chain for long lengths", () => {
    const p = pixelStretchPrimitives({ w: 800, h: 100, direction: "right", linePos: 0.5, length: 300, density: 1 });
    expect(p.match(/feDisplacementMap/g)?.length).toBe(2);
    expect(p).toContain('in="ps1"');
    expect(p.match(/data:image\/png/g)?.length).toBe(2);
  });

  it("emits a single stage for short lengths", () => {
    const p = pixelStretchPrimitives({ w: 800, h: 100, direction: "right", linePos: 0.5, length: 100, density: 1 });
    expect(p.match(/feDisplacementMap/g)?.length).toBe(1);
  });
});

describe("pixelStretch wiring (§2.2 4 配線点・回帰テスト)", () => {
  it("is registered in DISPLACEMENT_EFFECT_TYPES", () => {
    expect(DISPLACEMENT_EFFECT_TYPES.has("pixelStretch")).toBe(true);
  });
  it("is registered in FAST_DISPLACEMENT_EFFECT_TYPES", () => {
    expect(FAST_DISPLACEMENT_EFFECT_TYPES.has("pixelStretch")).toBe(true);
  });
  it("is registered in LIVE_DISPLACEMENT_EFFECT_TYPES", () => {
    expect(LIVE_DISPLACEMENT_EFFECT_TYPES.has("pixelStretch")).toBe(true);
  });
});

describe("PIXEL_STRETCH_EFFECT_DEF apply", () => {
  it("length=0 returns null", () => {
    expect(PIXEL_STRETCH_EFFECT_DEF.apply({ length: 0 }, ctx)).toBeNull();
  });

  it("returns a feDisplacementMap chain referencing a raw PNG feImage", () => {
    const r = PIXEL_STRETCH_EFFECT_DEF.apply({ direction: "right", linePos: 0.5, length: 300 }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain("feDisplacementMap");
      expect(r.primitives).toContain("data:image/png");
    }
  });

  it("density defaults to 1 (matches explicit density=1)", () => {
    const a = PIXEL_STRETCH_EFFECT_DEF.apply({ direction: "right", linePos: 0.5, length: 300 }, ctx);
    const b = PIXEL_STRETCH_EFFECT_DEF.apply({ direction: "right", linePos: 0.5, length: 300, density: 1 }, ctx);
    expect(a).toEqual(b);
  });

  it("lineBias defaults to 8 (PLAN-ALT-1 WP-3 baked baseline) and is passed through", () => {
    const a = PIXEL_STRETCH_EFFECT_DEF.apply({ direction: "right", linePos: 0.5, length: 300 }, ctx);
    const b = PIXEL_STRETCH_EFFECT_DEF.apply({ direction: "right", linePos: 0.5, length: 300, lineBias: 8 }, ctx);
    expect(a).toEqual(b);
    const c = PIXEL_STRETCH_EFFECT_DEF.apply({ direction: "right", linePos: 0.5, length: 300, lineBias: 0 }, ctx);
    expect(c).not.toEqual(a);
  });

  it("falls back to 'right' for an unknown direction", () => {
    const known = PIXEL_STRETCH_EFFECT_DEF.apply({ direction: "right", linePos: 0.5, length: 300 }, ctx);
    const bogus = PIXEL_STRETCH_EFFECT_DEF.apply({ direction: "sideways", linePos: 0.5, length: 300 }, ctx);
    expect(bogus).toEqual(known);
  });
});
