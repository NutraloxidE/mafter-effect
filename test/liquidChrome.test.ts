import { describe, expect, it } from "vitest";
import { LIQUID_CHROME_EFFECT_DEF } from "../src/runtime/fastEffects";
import {
  DISPLACEMENT_EFFECT_TYPES,
  FAST_DISPLACEMENT_EFFECT_TYPES,
  LIVE_DISPLACEMENT_EFFECT_TYPES,
  liquidChromePrimitives,
} from "../src/runtime/effectSvg";

const baseOpts = {
  amount: 18,
  size: 100,
  evolution: 0,
  highlight: 1,
  depth: 6,
  seed: 7,
  quality: 1,
  w: 400,
  h: 300,
};

describe("liquidChromePrimitives (pure)", () => {
  it("is deterministic for the same inputs", () => {
    expect(liquidChromePrimitives(baseOpts)).toEqual(liquidChromePrimitives(baseOpts));
  });

  it("contains the 3-stage chain: displace -> feSpecularLighting -> gradientMap", () => {
    const s = liquidChromePrimitives(baseOpts);
    expect(s).toContain("feDisplacementMap");
    expect(s).toContain("feSpecularLighting");
    expect(s).toContain("feDistantLight");
    expect(s).toContain("feComponentTransfer");
  });

  it("differs when amount changes (displacement scale wired through)", () => {
    const a = liquidChromePrimitives(baseOpts);
    const b = liquidChromePrimitives({ ...baseOpts, amount: 60 });
    expect(a).not.toEqual(b);
    expect(a).toContain('scale="18"');
    expect(b).toContain('scale="60"');
  });

  it("differs when highlight/depth change (feSpecularLighting params wired through)", () => {
    const a = liquidChromePrimitives(baseOpts);
    const b = liquidChromePrimitives({ ...baseOpts, highlight: 1.8, depth: 12 });
    expect(a).not.toEqual(b);
    expect(b).toContain('specularConstant="1.8"');
    expect(b).toContain('surfaceScale="12"');
  });

  it("quality below 0.5 drops to a single octave", () => {
    const hi = liquidChromePrimitives({ ...baseOpts, quality: 1 });
    const lo = liquidChromePrimitives({ ...baseOpts, quality: 0.2 });
    expect(hi).toContain('numOctaves="2"');
    expect(lo).toContain('numOctaves="1"');
  });

  it("pads the feTurbulence generation region so an evolution pan doesn't expose its edge", () => {
    // evolution=90deg with size=100 → dist=25px along +y (dx=cos(90)*25≈0, dy=sin(90)*25=25)。
    // feTurbulence の x/y/width/height は (0,0,w,h) 固定ではなく |pan|+2 分だけ対称拡張されている必要がある。
    const s = liquidChromePrimitives({ ...baseOpts, evolution: 90 });
    const m = s.match(/<feTurbulence[^>]*\bx="(-?[\d.]+)"[^>]*\by="(-?[\d.]+)"[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/);
    expect(m).not.toBeNull();
    const [, x, y, width, height] = m!;
    expect(Number(x)).toBeLessThan(0);
    expect(Number(y)).toBeLessThan(0);
    expect(Number(width)).toBeGreaterThan(baseOpts.w);
    expect(Number(height)).toBeGreaterThan(baseOpts.h);
  });

  it("evolution=0 still pads by the minimum margin (no unpadded (0,0,w,h) region)", () => {
    const s = liquidChromePrimitives({ ...baseOpts, evolution: 0 });
    expect(s).toContain(`x="-2" y="-2" width="${baseOpts.w + 4}" height="${baseOpts.h + 4}"`);
  });
});

describe("liquidChrome wiring (§2.2 4 配線点)", () => {
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
  it("apply() returns null when amount is 0", () => {
    const out = LIQUID_CHROME_EFFECT_DEF.apply(
      { amount: 0, size: 100, evolution: 0, highlight: 1, depth: 6, seed: 7, quality: 1 },
      { width: 400, height: 300, frame: 0 },
    );
    expect(out).toBeNull();
  });

  it("apply() returns an svg primitives chain for a nonzero amount", () => {
    const out = LIQUID_CHROME_EFFECT_DEF.apply(
      { amount: 18, size: 100, evolution: 0, highlight: 1, depth: 6, seed: 7, quality: 1 },
      { width: 400, height: 300, frame: 0 },
    );
    expect(out).not.toBeNull();
    expect(out?.kind).toBe("svg");
    if (out?.kind === "svg") {
      expect(out.primitives).toContain("feSpecularLighting");
    }
  });

  it("executionPath is live and category is スタイライズ", () => {
    expect(LIQUID_CHROME_EFFECT_DEF.executionPath).toBe("live");
    expect(LIQUID_CHROME_EFFECT_DEF.category).toBe("スタイライズ");
  });
});
