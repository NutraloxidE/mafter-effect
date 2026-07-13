import { describe, expect, it } from "vitest";
import { PIXEL_STRETCH_EFFECT_DEF } from "../src/runtime/fastEffects";
import {
  DISPLACEMENT_EFFECT_TYPES,
  FAST_DISPLACEMENT_EFFECT_TYPES,
  LIVE_DISPLACEMENT_EFFECT_TYPES,
  pixelStretchDisplaceMapPng,
} from "../src/runtime/effectSvg";
import { decodePngDataUri } from "./helpers/decodePng";

const ctx = { width: 1920, height: 1080, frame: 0 };

describe("pixelStretchDisplaceMapPng (pure)", () => {
  it("is deterministic for the same inputs", () => {
    const a = pixelStretchDisplaceMapPng({ w: 1920, h: 1080, direction: "right", linePos: 0.5, length: 300 });
    const b = pixelStretchDisplaceMapPng({ w: 1920, h: 1080, direction: "right", linePos: 0.5, length: 300 });
    expect(a).toEqual(b);
  });

  it("returns a raw PNG data URI", () => {
    const { uri } = pixelStretchDisplaceMapPng({ w: 200, h: 200, direction: "right", linePos: 0.5, length: 100 });
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("scale is 2×length (feDisplacementMap magnitude = scale·0.5 = length)", () => {
    const { scale } = pixelStretchDisplaceMapPng({ w: 200, h: 200, direction: "right", linePos: 0.5, length: 250 });
    expect(scale).toBe(500);
  });

  it("every column inside the band samples the source line (±1px)", () => {
    // right: source column = linePos*w, band = [line, line+length]. pull-model:
    // sampled = x + scale*(R/255 - 0.5) must equal `line` for all x in band.
    const w = 200;
    const length = 100;
    const linePos = 0.5;
    const { uri, scale } = pixelStretchDisplaceMapPng({ w, h: 4, direction: "right", linePos, length });
    const { width, height, rgba } = decodePngDataUri(uri);
    expect(width).toBe(w); // horizontal → w×1 buffer
    expect(height).toBe(1);
    const line = Math.round(linePos * w);
    for (let x = line; x <= Math.min(line + length, w - 1); x++) {
      const R = rgba[x * 4]!;
      const sampled = x + scale * (R / 255 - 0.5);
      expect(Math.abs(sampled - line)).toBeLessThanOrEqual(1);
    }
    // outside the band the map is neutral (128 → no displacement)
    expect(rgba[(line - 5) * 4]).toBe(128);
  });

  it("left direction lays the band in front of the line", () => {
    const w = 200;
    const length = 60;
    const { uri, scale } = pixelStretchDisplaceMapPng({ w, h: 2, direction: "left", linePos: 0.5, length });
    const { rgba } = decodePngDataUri(uri);
    const line = 100;
    for (let x = line - length; x <= line; x++) {
      const R = rgba[x * 4]!;
      const sampled = x + scale * (R / 255 - 0.5);
      expect(Math.abs(sampled - line)).toBeLessThanOrEqual(1);
    }
    // ahead of the band (further left) neutral
    expect(rgba[(line - length - 5) * 4]).toBe(128);
  });

  it("down direction writes the G channel and uses a 1×h buffer", () => {
    const { uri } = pixelStretchDisplaceMapPng({ w: 300, h: 200, direction: "down", linePos: 0.25, length: 80 });
    const { width, height, rgba } = decodePngDataUri(uri);
    expect(width).toBe(1); // vertical → 1×h buffer
    expect(height).toBe(200);
    const line = Math.round(0.25 * 200);
    expect(rgba[(line + 10) * 4]).toBe(128); // R neutral
    expect(rgba[(line + 10) * 4 + 1]).not.toBe(128); // G displaced
  });

  it("horizontal output is independent of h (redundant axis collapse)", () => {
    const a = pixelStretchDisplaceMapPng({ w: 640, h: 1080, direction: "right", linePos: 0.5, length: 200 });
    const b = pixelStretchDisplaceMapPng({ w: 640, h: 64, direction: "right", linePos: 0.5, length: 200 });
    expect(a.uri).toBe(b.uri);
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

  it("falls back to 'right' for an unknown direction", () => {
    const known = PIXEL_STRETCH_EFFECT_DEF.apply({ direction: "right", linePos: 0.5, length: 300 }, ctx);
    const bogus = PIXEL_STRETCH_EFFECT_DEF.apply({ direction: "sideways", linePos: 0.5, length: 300 }, ctx);
    expect(bogus).toEqual(known);
  });
});
