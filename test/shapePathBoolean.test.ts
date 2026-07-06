import { describe, expect, it } from "vitest";
import {
  composeRings,
  ellipseToRing,
  flattenVerticesToRing,
  multiPolygonToPathD,
  rectToRing,
} from "../src/runtime/shapePathBoolean";
import type { ResolvedShapeVertex } from "../src/runtime/shapePath";

function v(id: string, x: number, y: number, extra: Partial<ResolvedShapeVertex> = {}): ResolvedShapeVertex {
  return { id, pos: { x, y, z: 0 }, ...extra };
}

// axis-aligned square, size x size, top-left at (x0,y0)
function square(x0: number, y0: number, size: number): ResolvedShapeVertex[] {
  return [
    v("a", x0, y0),
    v("b", x0 + size, y0),
    v("c", x0 + size, y0 + size),
    v("d", x0, y0 + size),
  ];
}

describe("flattenVerticesToRing (§5.5c shape kind=path)", () => {
  it("returns one point per vertex when no tangents are present (straight edges)", () => {
    const ring = flattenVerticesToRing(square(0, 0, 10));
    expect(ring).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
  });

  it("subdivides a curved edge into extra points between endpoints", () => {
    const vertices = [
      v("a", 0, 0, { outTangent: { x: 5, y: 0, z: 0 } }),
      v("b", 10, 0),
    ];
    const ring = flattenVerticesToRing(vertices, 4);
    expect(ring.length).toBe(1 + 3 + 1);
    expect(ring[0]).toEqual([0, 0]);
    expect(ring[ring.length - 1]).toEqual([10, 0]);
  });

  it("returns empty for fewer than 2 vertices", () => {
    expect(flattenVerticesToRing([])).toEqual([]);
    expect(flattenVerticesToRing([v("a", 0, 0)])).toEqual([]);
  });
});

describe("rectToRing / ellipseToRing (§5.5d merge inputs from rect/ellipse shapes)", () => {
  it("rectToRing returns the 4 corners at the local origin (top-left)", () => {
    expect(rectToRing({ x: 20, y: 10 })).toEqual([[0, 0], [20, 0], [20, 10], [0, 10]]);
  });

  it("ellipseToRing approximates an N-gon centered on the bounding box", () => {
    const ring = ellipseToRing({ x: 10, y: 10 }, 4);
    expect(ring).toHaveLength(4);
    // circle of radius 5 centered at (5,5): first point at theta=0 -> (10,5)
    expect(ring[0]![0]).toBeCloseTo(10, 6);
    expect(ring[0]![1]).toBeCloseTo(5, 6);
  });
});

describe("composeRings (§5.5d Pathfinder semantics)", () => {
  function opRing(op: "unite" | "subtract" | "intersect" | "exclude", ring: ReturnType<typeof rectToRing>) {
    return { op, ring };
  }

  it("a single ring passes through unmodified (op ignored for the base shape)", () => {
    const mp = composeRings([opRing("unite", flattenVerticesToRing(square(0, 0, 10)))]);
    expect(mp).toHaveLength(1);
    expect(mp[0]).toHaveLength(1);
  });

  it("unite of two overlapping squares yields a single combined polygon (no holes)", () => {
    const mp = composeRings([
      opRing("unite", flattenVerticesToRing(square(0, 0, 10))),
      opRing("unite", flattenVerticesToRing(square(5, 5, 10))),
    ]);
    expect(mp).toHaveLength(1);
    expect(mp[0]).toHaveLength(1);
  });

  it("subtract of a fully-contained inner square carves a hole", () => {
    const mp = composeRings([
      opRing("unite", flattenVerticesToRing(square(0, 0, 20))),
      opRing("subtract", flattenVerticesToRing(square(5, 5, 5))),
    ]);
    expect(mp).toHaveLength(1);
    expect(mp[0]).toHaveLength(2); // outer ring + 1 hole
  });

  it("intersect of two disjoint squares yields an empty result", () => {
    const mp = composeRings([
      opRing("unite", flattenVerticesToRing(square(0, 0, 5))),
      opRing("intersect", flattenVerticesToRing(square(100, 100, 5))),
    ]);
    expect(mp).toEqual([]);
  });

  it("ignores degenerate rings (fewer than 3 points)", () => {
    const mp = composeRings([
      opRing("unite", [[0, 0], [10, 0]]), // only 2 points, not a polygon
      opRing("unite", flattenVerticesToRing(square(0, 0, 10))),
    ]);
    expect(mp).toHaveLength(1);
  });

  it("is a pure function (same input -> same output)", () => {
    const rings = [opRing("unite", flattenVerticesToRing(square(0, 0, 10))), opRing("unite", flattenVerticesToRing(square(5, 5, 10)))];
    expect(composeRings(rings)).toEqual(composeRings(rings));
  });

  it("composes a rect input with an ellipse input", () => {
    const mp = composeRings([
      opRing("unite", rectToRing({ x: 20, y: 20 })),
      opRing("unite", ellipseToRing({ x: 10, y: 10 })),
    ]);
    expect(mp).toHaveLength(1);
  });
});

describe("multiPolygonToPathD", () => {
  it("formats a simple polygon as M...L...Z", () => {
    const d = multiPolygonToPathD([[[[0, 0], [10, 0], [10, 10], [0, 10]]]]);
    expect(d).toBe("M 0,0 L 10,0 L 10,10 L 0,10 Z");
  });

  it("returns empty string for an empty MultiPolygon", () => {
    expect(multiPolygonToPathD([])).toBe("");
  });

  it("builds a hole (2 M...Z segments) end-to-end from subtract", () => {
    const mp = composeRings([
      { op: "unite" as const, ring: flattenVerticesToRing(square(0, 0, 20)) },
      { op: "subtract" as const, ring: flattenVerticesToRing(square(5, 5, 5)) },
    ]);
    const d = multiPolygonToPathD(mp);
    const segments = d.split(" Z").filter((s) => s.trim().length > 0);
    expect(segments).toHaveLength(2);
  });
});
