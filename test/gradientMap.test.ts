import { describe, expect, it } from "vitest";
import { GRADIENT_MAP_EFFECT_DEF } from "../src/runtime/builtinEffects";
import {
  GRADIENT_MAP_PRESETS,
  gradientMapTable,
  sampleGradientStops,
} from "../src/runtime/effectSvg";

const ctx = { width: 1920, height: 1080, frame: 0 };

function parseTable(s: string): number[] {
  return s.split(/\s+/).filter(Boolean).map(Number);
}

describe("gradientMapTable (pure)", () => {
  it("returns 17 values per channel for thermal phase 0", () => {
    const t = gradientMapTable("thermal", 0, { r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 });
    const r = parseTable(t.r);
    const g = parseTable(t.g);
    const b = parseTable(t.b);
    expect(r).toHaveLength(17);
    expect(g).toHaveLength(17);
    expect(b).toHaveLength(17);
    // endpoints at phase 0: first stop of thermal, last stop of thermal
    const first = GRADIENT_MAP_PRESETS["thermal"]![0]!;
    const last = GRADIENT_MAP_PRESETS["thermal"]![GRADIENT_MAP_PRESETS["thermal"]!.length - 1]!;
    expect(r[0]).toBeCloseTo(first.r, 5);
    expect(g[0]).toBeCloseTo(first.g, 5);
    expect(b[0]).toBeCloseTo(first.b, 5);
    expect(r[16]).toBeCloseTo(last.r, 5);
    expect(g[16]).toBeCloseTo(last.g, 5);
    expect(b[16]).toBeCloseTo(last.b, 5);
  });

  it("phase=180 half-cycle shifts samples (index 0 ≈ old mid)", () => {
    const base = gradientMapTable("thermal", 0, { r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 });
    const shifted = gradientMapTable("thermal", 180, { r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 });
    const baseR = parseTable(base.r);
    const shiftR = parseTable(shifted.r);
    // phase 0.5: sample at t=0 is base sample at t=0.5 ≈ index 8 of 17 (8/16=0.5)
    expect(shiftR[0]).toBeCloseTo(baseR[8]!, 5);
    // sample at t=0.5 under phase 0.5 is base at t=0 (mod 1) ≈ index 0
    expect(shiftR[8]).toBeCloseTo(baseR[0]!, 5);
  });

  it("duotone uses colorA/colorB as endpoints", () => {
    const colorA = { r: 0.1, g: 0.2, b: 0.3 };
    const colorB = { r: 0.9, g: 0.8, b: 0.7 };
    const t = gradientMapTable("duotone", 0, colorA, colorB);
    const r = parseTable(t.r);
    const g = parseTable(t.g);
    const b = parseTable(t.b);
    expect(r[0]).toBeCloseTo(colorA.r, 5);
    expect(g[0]).toBeCloseTo(colorA.g, 5);
    expect(b[0]).toBeCloseTo(colorA.b, 5);
    expect(r[16]).toBeCloseTo(colorB.r, 5);
    expect(g[16]).toBeCloseTo(colorB.g, 5);
    expect(b[16]).toBeCloseTo(colorB.b, 5);
  });

  it("unknown preset falls back to thermal", () => {
    const a = gradientMapTable("thermal", 0, { r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 });
    const b = gradientMapTable("no-such-preset", 0, { r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 });
    expect(b).toEqual(a);
  });

  it("sampleGradientStops interpolates mid stops", () => {
    const stops = GRADIENT_MAP_PRESETS["thermal"]!;
    const mid = sampleGradientStops(stops, 0.5);
    // thermal has a stop exactly at 0.5
    const exact = stops.find((s) => s.stop === 0.5)!;
    expect(mid.r).toBeCloseTo(exact.r, 5);
    expect(mid.g).toBeCloseTo(exact.g, 5);
    expect(mid.b).toBeCloseTo(exact.b, 5);
  });
});

describe("GRADIENT_MAP_EFFECT_DEF apply", () => {
  it("returns null when amount is 0", () => {
    expect(
      GRADIENT_MAP_EFFECT_DEF.apply(
        { preset: "thermal", amount: 0, phase: 0, colorA: { r: 0, g: 0, b: 0, a: 1 }, colorB: { r: 1, g: 1, b: 1, a: 1 } },
        ctx,
      ),
    ).toBeNull();
  });

  it("clamps amount to 0..1 and returns null for negative", () => {
    expect(
      GRADIENT_MAP_EFFECT_DEF.apply(
        { preset: "thermal", amount: -1, phase: 0, colorA: { r: 0, g: 0, b: 0, a: 1 }, colorB: { r: 1, g: 1, b: 1, a: 1 } },
        ctx,
      ),
    ).toBeNull();
  });

  it("returns svg chain: saturate → table transfer → arithmetic mix", () => {
    const r = GRADIENT_MAP_EFFECT_DEF.apply(
      {
        preset: "acid",
        amount: 0.75,
        phase: 0,
        colorA: { r: 0, g: 0, b: 0, a: 1 },
        colorB: { r: 1, g: 1, b: 1, a: 1 },
      },
      ctx,
    );
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain('type="saturate" values="0"');
      expect(r.primitives).toContain('type="table"');
      expect(r.primitives).toContain('operator="arithmetic"');
      expect(r.primitives).toContain('k2="0.75"');
      expect(r.primitives).toContain('k3="0.25"');
    }
  });

  it("amount=1 mixes fully mapped (k2=1 k3=0)", () => {
    const r = GRADIENT_MAP_EFFECT_DEF.apply(
      {
        preset: "chrome",
        amount: 1,
        phase: 0,
        colorA: { r: 0, g: 0, b: 0, a: 1 },
        colorB: { r: 1, g: 1, b: 1, a: 1 },
      },
      ctx,
    );
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain('k2="1"');
      expect(r.primitives).toContain('k3="0"');
    }
  });
});
