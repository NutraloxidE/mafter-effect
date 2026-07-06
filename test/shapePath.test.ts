import { describe, expect, it } from "vitest";
import { buildMultiRingPathD, buildShapePathD, type ResolvedShapeVertex } from "../src/runtime/shapePath";

function v(id: string, x: number, y: number, extra: Partial<ResolvedShapeVertex> = {}): ResolvedShapeVertex {
  return { id, pos: { x, y, z: 0 }, ...extra };
}

describe("buildShapePathD (§5.5c shape kind=path)", () => {
  it("returns empty string for fewer than 2 vertices", () => {
    expect(buildShapePathD([])).toBe("");
    expect(buildShapePathD([v("a", 0, 0)])).toBe("");
  });

  it("builds a straight-line closed path when no tangents are present", () => {
    const d = buildShapePathD([v("a", 0, 0), v("b", 100, 0), v("c", 50, 100)]);
    expect(d).toBe("M 0,0 L 100,0 L 50,100 L 0,0 Z");
  });

  it("uses a cubic bezier segment when either endpoint has a tangent", () => {
    const d = buildShapePathD([
      v("a", 0, 0, { outTangent: { x: 10, y: 0, z: 0 } }),
      v("b", 100, 0),
    ]);
    // a→b: cubic (outTangent offsets a's control point; b has no inTangent so its control point = b.pos).
    // b→a (closing the loop): straight line, since neither endpoint has a tangent for that segment.
    expect(d).toBe("M 0,0 C 10,0 100,0 100,0 L 0,0 Z");
  });

  it("is a pure function (same input → same output, no mutation)", () => {
    const vertices = [v("a", 0, 0), v("b", 100, 0), v("c", 50, 100)];
    const before = JSON.stringify(vertices);
    const d1 = buildShapePathD(vertices);
    const d2 = buildShapePathD(vertices);
    expect(d1).toBe(d2);
    expect(JSON.stringify(vertices)).toBe(before);
  });
});

describe("buildMultiRingPathD (§5.5e shape rings — merge Bake output)", () => {
  it("joins each ring's own M...Z segment", () => {
    const outer = [v("a", 0, 0), v("b", 20, 0), v("c", 20, 20), v("d", 0, 20)];
    const hole = [v("e", 5, 5), v("f", 15, 5), v("g", 15, 15), v("h", 5, 15)];
    const d = buildMultiRingPathD([outer, hole]);
    expect(d).toBe("M 0,0 L 20,0 L 20,20 L 0,20 L 0,0 Z M 5,5 L 15,5 L 15,15 L 5,15 L 5,5 Z");
  });

  it("skips degenerate rings (fewer than 2 vertices) without breaking adjacent rings", () => {
    const outer = [v("a", 0, 0), v("b", 20, 0), v("c", 20, 20)];
    const d = buildMultiRingPathD([[], outer, [v("z", 0, 0)]]);
    expect(d).toBe("M 0,0 L 20,0 L 20,20 L 0,0 Z");
  });

  it("returns empty string for no rings", () => {
    expect(buildMultiRingPathD([])).toBe("");
  });
});
