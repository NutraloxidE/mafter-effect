import { describe, expect, it } from "vitest";
import { POSTERIZE_EFFECT_DEF, posterizeTable } from "../src/runtime/builtinEffects";

const ctx = { width: 1920, height: 1080, frame: 0 };

function parseTable(s: string): number[] {
  return s.split(/\s+/).filter(Boolean).map(Number);
}

describe("posterizeTable (pure)", () => {
  it("levels=2 returns 0 1", () => {
    expect(posterizeTable(2)).toBe("0 1");
  });

  it("levels=4 returns four equal steps", () => {
    const vals = parseTable(posterizeTable(4));
    expect(vals).toHaveLength(4);
    expect(vals[0]).toBeCloseTo(0, 10);
    expect(vals[1]).toBeCloseTo(1 / 3, 10);
    expect(vals[2]).toBeCloseTo(2 / 3, 10);
    expect(vals[3]).toBeCloseTo(1, 10);
  });

  it("clamps levels < 2 to 2", () => {
    expect(posterizeTable(1)).toBe("0 1");
    expect(posterizeTable(0)).toBe("0 1");
    expect(posterizeTable(-3)).toBe("0 1");
  });

  it("rounds non-integer levels", () => {
    expect(posterizeTable(3.4)).toBe(posterizeTable(3));
    expect(posterizeTable(3.6)).toBe(posterizeTable(4));
  });
});

describe("POSTERIZE_EFFECT_DEF apply", () => {
  it("returns discrete feComponentTransfer for default levels", () => {
    const r = POSTERIZE_EFFECT_DEF.apply({ levels: 6 }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain('type="discrete"');
      expect(r.primitives).toContain(`tableValues="${posterizeTable(6)}"`);
      expect(r.primitives).toContain("feFuncR");
      expect(r.primitives).toContain("feFuncG");
      expect(r.primitives).toContain("feFuncB");
    }
  });

  it("clamps levels in apply", () => {
    const r = POSTERIZE_EFFECT_DEF.apply({ levels: 1 }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain(`tableValues="${posterizeTable(2)}"`);
    }
  });
});
