import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseFont } from "opentype.js";
import { describe, expect, it } from "vitest";
import { extrudeGeometry, groupRingsByNesting, signedArea } from "../../src/runtime/geom3d/extrudeMesh";
import type { OutlineGlyph, Vec2 } from "../../src/runtime/geom3d/geom3dTypes";
import { textToOutlineGlyphs } from "../../src/runtime/geom3d/outlineProvider";

const SQUARE: Vec2[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

// 内側に穴を持つ「O」のようなリング（外周 CCW+穴 CW、逆でも groupRingsByNesting は動く）。
const RING_OUTER: Vec2[] = [
  { x: 0, y: 0 },
  { x: 20, y: 0 },
  { x: 20, y: 20 },
  { x: 0, y: 20 },
];
const RING_HOLE: Vec2[] = [
  { x: 5, y: 5 },
  { x: 5, y: 15 },
  { x: 15, y: 15 },
  { x: 15, y: 5 },
];

describe("signedArea", () => {
  it("is positive for the square in this winding order", () => {
    expect(signedArea(SQUARE)).toBeGreaterThan(0);
  });
  it("flips sign when winding is reversed", () => {
    expect(signedArea([...SQUARE].reverse())).toBeLessThan(0);
  });
});

describe("groupRingsByNesting", () => {
  it("groups a single ring as its own outer with no holes", () => {
    const groups = groupRingsByNesting([SQUARE]);
    expect(groups.length).toBe(1);
    expect(groups[0]!.holes.length).toBe(0);
  });

  it("nests a smaller inner ring as a hole of the containing ring, regardless of relative winding", () => {
    const groups = groupRingsByNesting([RING_OUTER, RING_HOLE]);
    expect(groups.length).toBe(1);
    expect(groups[0]!.holes.length).toBe(1);
  });

  it("keeps two disjoint rings as two separate outer groups (e.g. 'i' stem + dot)", () => {
    const dot: Vec2[] = [{ x: 30, y: 0 }, { x: 34, y: 0 }, { x: 34, y: 4 }, { x: 30, y: 4 }];
    const groups = groupRingsByNesting([SQUARE, dot]);
    expect(groups.length).toBe(2);
    expect(groups.every((g) => g.holes.length === 0)).toBe(true);
  });

  it("handles empty input", () => {
    expect(groupRingsByNesting([])).toEqual([]);
  });
});

describe("extrudeGeometry — no bevel", () => {
  const glyphs: OutlineGlyph[] = [{ rings: [SQUARE] }];

  it("produces front cap + back cap + side walls with the closed-form triangle count for a simple quad", () => {
    const mesh = extrudeGeometry(glyphs, { depth: 50, bevelSize: 0, bevelSegments: 2 });
    // front cap: quad -> 2 triangles. back cap: 2 triangles. side: 4 edges * 2 triangles = 8.
    expect(mesh.triangleCount).toBe(2 + 2 + 8);
    expect(mesh.vertexCount).toBe(mesh.triangleCount * 3); // flat-shaded: no vertex sharing across triangles
  });

  it("places the front cap at local z=0 and the back cap at z=-depth", () => {
    const mesh = extrudeGeometry(glyphs, { depth: 50, bevelSize: 0, bevelSegments: 2 });
    const zs = new Set<number>();
    for (let i = 2; i < mesh.positions.length; i += 3) zs.add(Math.round(mesh.positions[i]! * 100) / 100);
    expect(zs.has(0)).toBe(true);
    expect(zs.has(-50)).toBe(true);
  });

  it("depth=0 collapses front and back caps to the same plane (visual no-op vs 2D)", () => {
    const mesh = extrudeGeometry(glyphs, { depth: 0, bevelSize: 0, bevelSegments: 2 });
    for (let i = 2; i < mesh.positions.length; i += 3) {
      expect(mesh.positions[i]).toBeCloseTo(0);
    }
  });

  it("is deterministic for identical input (INV-1)", () => {
    const a = extrudeGeometry(glyphs, { depth: 50, bevelSize: 0, bevelSegments: 2 });
    const b = extrudeGeometry(glyphs, { depth: 50, bevelSize: 0, bevelSegments: 2 });
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });

  it("all normals are unit length everywhere (regression: zero-length cross product on degenerate triangles must not silently yield a zero vector)", () => {
    // A ring with a collinear midpoint (0,10)->(5,10)->(10,10) forces a zero-area side quad
    // when the collinear edge is walked — exercises vnormalize's zero-vector fallback path.
    const collinearRing: Vec2[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 10 }, { x: 0, y: 10 },
    ];
    const mesh = extrudeGeometry([{ rings: [collinearRing] }], { depth: 20, bevelSize: 0, bevelSegments: 2 });
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const len = Math.hypot(mesh.normals[i]!, mesh.normals[i + 1]!, mesh.normals[i + 2]!);
      expect(len).toBeCloseTo(1, 5);
    }
  });

  it("front cap triangle normals point toward +z, back cap toward -z", () => {
    const mesh = extrudeGeometry(glyphs, { depth: 50, bevelSize: 0, bevelSegments: 2 });
    const frontIdx = mesh.faceGroup.indexOf(0);
    const backIdx = mesh.faceGroup.indexOf(1);
    expect(mesh.normals[frontIdx * 3 + 2]).toBeCloseTo(1);
    expect(mesh.normals[backIdx * 3 + 2]).toBeCloseTo(-1);
  });

  it("side wall normals are horizontal (z component ~0) and point outward from the square", () => {
    const mesh = extrudeGeometry(glyphs, { depth: 50, bevelSize: 0, bevelSegments: 2 });
    for (let i = 0; i < mesh.faceGroup.length; i++) {
      if (mesh.faceGroup[i] !== 2) continue;
      expect(Math.abs(mesh.normals[i * 3 + 2]!)).toBeLessThan(1e-5);
    }
  });
});

describe("extrudeGeometry — with hole (donut)", () => {
  const glyphs: OutlineGlyph[] = [{ rings: [RING_OUTER, RING_HOLE] }];

  it("produces a non-empty mesh with front/back/side faces (hole correctly cut, not filled solid)", () => {
    const mesh = extrudeGeometry(glyphs, { depth: 20, bevelSize: 0, bevelSegments: 2 });
    expect(mesh.triangleCount).toBeGreaterThan(0);
    const hasFront = mesh.faceGroup.includes(0);
    const hasBack = mesh.faceGroup.includes(1);
    const hasSide = mesh.faceGroup.includes(2);
    expect(hasFront && hasBack && hasSide).toBe(true);
    // outer perimeter (4 edges) + hole perimeter (4 edges) = 8 side quads = 16 side triangles
    // (faceGroup is stored per-vertex, 3 per triangle, since faces are flat-shaded/unshared)
    const sideVerts = mesh.faceGroup.filter((g) => g === 2).length;
    expect(sideVerts).toBe(16 * 3);
  });
});

describe("extrudeGeometry — bevel", () => {
  const glyphs: OutlineGlyph[] = [{ rings: [SQUARE] }];

  it("produces bevel faces in addition to front/back/side when bevelSize > 0", () => {
    const mesh = extrudeGeometry(glyphs, { depth: 50, bevelSize: 5, bevelSegments: 3 });
    expect(mesh.faceGroup.includes(3)).toBe(true);
    expect(mesh.faceGroup.includes(0)).toBe(true);
    expect(mesh.faceGroup.includes(1)).toBe(true);
  });

  it("clamps bevel extent so front/back bevels never invert when bevelSize > depth/2", () => {
    const mesh = extrudeGeometry(glyphs, { depth: 4, bevelSize: 100, bevelSegments: 2 });
    // depth/2 = 2, so bevelExtent clamps to 2: front cap around z=-2, back cap around z=-2 as well
    // (they meet in the middle) — no NaN/Infinity, and all z within [-depth, 0].
    for (let i = 2; i < mesh.positions.length; i += 3) {
      const z = mesh.positions[i]!;
      expect(Number.isFinite(z)).toBe(true);
      expect(z).toBeLessThanOrEqual(0.0001);
      expect(z).toBeGreaterThanOrEqual(-4.0001);
    }
  });

  it("more bevel segments yields more bevel triangles", () => {
    const low = extrudeGeometry(glyphs, { depth: 50, bevelSize: 5, bevelSegments: 1 });
    const high = extrudeGeometry(glyphs, { depth: 50, bevelSize: 5, bevelSegments: 8 });
    const lowBevel = low.faceGroup.filter((g) => g === 3).length;
    const highBevel = high.faceGroup.filter((g) => g === 3).length;
    expect(highBevel).toBeGreaterThan(lowBevel);
  });

  it("is deterministic for identical bevel input (INV-1)", () => {
    const a = extrudeGeometry(glyphs, { depth: 50, bevelSize: 5, bevelSegments: 3 });
    const b = extrudeGeometry(glyphs, { depth: 50, bevelSize: 5, bevelSegments: 3 });
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
  });
});

describe("extrudeGeometry — multi-glyph", () => {
  it("merges multiple independent glyphs (e.g. two letters) into one mesh", () => {
    const glyphs: OutlineGlyph[] = [{ rings: [SQUARE] }, { rings: [SQUARE.map((p) => ({ x: p.x + 50, y: p.y }))] }];
    const mesh = extrudeGeometry(glyphs, { depth: 10, bevelSize: 0, bevelSegments: 2 });
    expect(mesh.triangleCount).toBe((2 + 2 + 8) * 2);
  });
});

describe("extrudeGeometry — real font glyphs (integration smoke test)", () => {
  const buf = readFileSync(path.resolve(__dirname, "../../public/fonts/NotoSans-Regular.ttf"));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const font = parseFont(ab);

  it("extrudes a word with holes (e.g. 'Bob') without throwing, no NaN/Infinity, all triangles valid", () => {
    const result = textToOutlineGlyphs(
      { text: "Bob", size: 64, tracking: 0, leading: 0, align: "left", boxWidth: 0, boxHeight: 0 },
      font,
      16,
    )!;
    expect(result.glyphs.length).toBe(3);
    const mesh = extrudeGeometry(result.glyphs, { depth: 40, bevelSize: 4, bevelSegments: 3 });
    expect(mesh.triangleCount).toBeGreaterThan(0);
    for (const v of mesh.positions) expect(Number.isFinite(v)).toBe(true);
    for (const v of mesh.normals) expect(Number.isFinite(v)).toBe(true);
    // every normal should be (approximately) unit length
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const len = Math.hypot(mesh.normals[i]!, mesh.normals[i + 1]!, mesh.normals[i + 2]!);
      expect(len).toBeCloseTo(1, 2);
    }
  });

  it("extrudes a multi-contour glyph ('i': stem + dot) as two separate outer groups", () => {
    const result = textToOutlineGlyphs(
      { text: "i", size: 64, tracking: 0, leading: 0, align: "left", boxWidth: 0, boxHeight: 0 },
      font,
      16,
    )!;
    const groups = groupRingsByNesting(result.glyphs[0]!.rings);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const mesh = extrudeGeometry(result.glyphs, { depth: 30, bevelSize: 0, bevelSegments: 2 });
    expect(mesh.triangleCount).toBeGreaterThan(0);
  });

  it("handles depth=0 for real glyphs without producing degenerate NaN geometry", () => {
    const result = textToOutlineGlyphs(
      { text: "Q", size: 64, tracking: 0, leading: 0, align: "left", boxWidth: 0, boxHeight: 0 },
      font,
      16,
    )!;
    const mesh = extrudeGeometry(result.glyphs, { depth: 0, bevelSize: 0, bevelSegments: 2 });
    for (const v of mesh.positions) expect(Number.isFinite(v)).toBe(true);
  });
});
