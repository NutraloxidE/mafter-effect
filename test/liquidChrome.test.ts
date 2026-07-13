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

  // evolution パンの「動く四角枠」回帰防止（padding では boiling するため feTile 方式で対策）。
  it("keeps the feTurbulence generation region fixed at (0,0,w,h) regardless of evolution (no boiling)", () => {
    const a = liquidChromePrimitives({ ...baseOpts, evolution: 0 });
    const b = liquidChromePrimitives({ ...baseOpts, evolution: 270 });
    const region = `<feTurbulence type="fractalNoise" baseFrequency="${1 / baseOpts.size} ${1 / baseOpts.size}" numOctaves="2" seed="7" stitchTiles="stitch" x="0" y="0" width="${baseOpts.w}" height="${baseOpts.h}"`;
    expect(a).toContain(region);
    expect(b).toContain(region);
  });

  it("tiles the noise (feTile) so an evolution pan and the specular edge normals stay covered (no rectangular frame)", () => {
    const s = liquidChromePrimitives({ ...baseOpts, evolution: 90 });
    // displacement 用 (noiseField) と specular bump 用 (bumpField) の 2 枚の seamless タイル。
    expect(s).toContain('result="noiseField"');
    expect(s).toContain('result="bumpField"');
    expect((s.match(/<feTile\b/g) ?? []).length).toBe(2);
  });

  it("reduces the evolution offset modulo the tile size so it never runs past the tiled field", () => {
    // evolution=3600 (10 revolutions) with size=100 → 生の dist=1000px だが、mod 100 で [0,100) に収まる。
    const s = liquidChromePrimitives({ ...baseOpts, evolution: 3600 });
    const m = s.match(/<feOffset[^>]*\bdx="(-?[\d.]+)"[^>]*\bdy="(-?[\d.]+)"/);
    if (m) {
      expect(Math.abs(Number(m[1]))).toBeLessThan(baseOpts.w);
      expect(Math.abs(Number(m[2]))).toBeLessThan(baseOpts.h);
    }
    // evolution=3600 は cos/sin が整数 revolution なので dx=dist,dy≈0 → mod 100 = 0 で feOffset 省略もあり得る。
    // その場合でも feTile は必ず存在する（生成域固定＋タイル被覆）。
    expect(s).toContain("<feTile");
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
