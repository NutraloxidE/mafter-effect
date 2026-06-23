import { describe, expect, it } from "vitest";
import {
  decomposeTrs,
  identity,
  invert,
  localMatrix,
  lookAt,
  multiply,
  orthographic,
  perspective,
  rotationZ,
  scaling,
  transformPoint,
  translation,
  vecCross,
  vecDot,
  vecLength,
  vecNormalize,
} from "../src/runtime/mat4";
import { vec3 } from "../src/core/props";

function expectVecClose(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
  expect(a.z).toBeCloseTo(b.z, 6);
}

describe("mat4 basics", () => {
  it("identity is multiplicative unit", () => {
    const m = translation(3, 4, 5);
    expect(multiply(identity(), m)).toEqual(m);
    expect(multiply(m, identity())).toEqual(m);
  });

  it("translation moves a point", () => {
    expectVecClose(transformPoint(translation(10, 20, 30), vec3(1, 2, 3)), vec3(11, 22, 33));
  });

  it("scaling scales a point", () => {
    expectVecClose(transformPoint(scaling(2, 3, 4), vec3(1, 1, 1)), vec3(2, 3, 4));
  });

  it("rotationZ(90deg) maps +x to +y", () => {
    expectVecClose(transformPoint(rotationZ(90), vec3(1, 0, 0)), vec3(0, 1, 0));
  });
});

describe("localMatrix — §6.3 compose order L = T(pos)·R·S·T(-anchor)", () => {
  it("anchor point maps to position (pivot semantics)", () => {
    const L = localMatrix(vec3(50, 50, 0), vec3(100, 100, 0), vec3(0, 0, 0), vec3(2, 2, 1));
    expectVecClose(transformPoint(L, vec3(50, 50, 0)), vec3(100, 100, 0));
  });

  it("scale happens around the anchor, not the origin", () => {
    // anchor=(50,50) position=(100,100) scale x2: content (0,0) → (-50,-50)·2 + 100 = (0,0)
    const L = localMatrix(vec3(50, 50, 0), vec3(100, 100, 0), vec3(0, 0, 0), vec3(2, 2, 1));
    expectVecClose(transformPoint(L, vec3(0, 0, 0)), vec3(0, 0, 0));
    // content (100,100) → (50,50)·2 + 100 = (200,200)
    expectVecClose(transformPoint(L, vec3(100, 100, 0)), vec3(200, 200, 0));
  });

  it("rotation pivots around anchor", () => {
    // anchor=(10,0) position=(10,0) rotateZ 90: content point (10,0)=anchor stays at position
    const L = localMatrix(vec3(10, 0, 0), vec3(10, 0, 0), vec3(0, 0, 90), vec3(1, 1, 1));
    expectVecClose(transformPoint(L, vec3(10, 0, 0)), vec3(10, 0, 0));
    // content (20,0): relative to anchor (10,0) → rotated 90 → (0,10) → + position = (10,10)
    expectVecClose(transformPoint(L, vec3(20, 0, 0)), vec3(10, 10, 0));
  });
});

describe("decomposeTrs", () => {
  it("round-trips localMatrix with anchor=0", () => {
    const cases = [
      { pos: vec3(10, 20, 0), rot: vec3(0, 0, 0), scale: vec3(1, 1, 1) },
      { pos: vec3(100, 50, 10), rot: vec3(10, 20, 30), scale: vec3(2, 1.5, 1) },
      { pos: vec3(0, 0, 0), rot: vec3(0, 0, 90), scale: vec3(1, 1, 1) },
    ];
    for (const c of cases) {
      const m = localMatrix(vec3(0, 0, 0), c.pos, c.rot, c.scale);
      const d = decomposeTrs(m);
      const rebuilt = localMatrix(vec3(0, 0, 0), d.position, d.rotation, d.scale);
      for (let i = 0; i < 16; i++) {
        expect(rebuilt[i]).toBeCloseTo(m[i]!, 4);
      }
    }
  });

  it("maps origin to position column", () => {
    const m = localMatrix(vec3(0, 0, 0), vec3(30, 40, 0), vec3(0, 0, 45), vec3(2, 2, 1));
    const d = decomposeTrs(m);
    expectVecClose(transformPoint(m, vec3(0, 0, 0)), d.position);
  });
});

describe("vec3 ops", () => {
  it("cross product is right-handed", () => {
    expectVecClose(vecCross(vec3(1, 0, 0), vec3(0, 1, 0)), vec3(0, 0, 1));
    expectVecClose(vecCross(vec3(0, 1, 0), vec3(0, 0, 1)), vec3(1, 0, 0));
  });

  it("dot and length", () => {
    expect(vecDot(vec3(1, 2, 3), vec3(4, 5, 6))).toBeCloseTo(32, 6);
    expect(vecLength(vec3(3, 4, 0))).toBeCloseTo(5, 6);
  });

  it("normalize yields unit length, zero stays zero", () => {
    expect(vecLength(vecNormalize(vec3(0, 0, 5)))).toBeCloseTo(1, 6);
    expectVecClose(vecNormalize(vec3(0, 0, 0)), vec3(0, 0, 0));
  });
});

describe("lookAt — RH view matrix (camera looks down -z)", () => {
  it("maps eye to origin", () => {
    const view = lookAt(vec3(0, 0, 10), vec3(0, 0, 0), vec3(0, 1, 0));
    expectVecClose(transformPoint(view, vec3(0, 0, 10)), vec3(0, 0, 0));
  });

  it("target sits in front of camera along -z", () => {
    const view = lookAt(vec3(0, 0, 10), vec3(0, 0, 0), vec3(0, 1, 0));
    // origin is 10 units in front → view-space z = -10.
    expectVecClose(transformPoint(view, vec3(0, 0, 0)), vec3(0, 0, -10));
  });

  it("eye≈center degenerates to pure translation", () => {
    const view = lookAt(vec3(5, 6, 7), vec3(5, 6, 7), vec3(0, 1, 0));
    expectVecClose(transformPoint(view, vec3(5, 6, 7)), vec3(0, 0, 0));
  });
});

describe("perspective — RH projection (NDC z∈[-1,1])", () => {
  it("matches gl-matrix formula entries", () => {
    const fov = 60;
    const aspect = 16 / 9;
    const near = 1;
    const far = 100;
    const f = 1 / Math.tan((fov * Math.PI) / 360);
    const p = perspective(fov, aspect, near, far);
    expect(p[0]).toBeCloseTo(f / aspect, 6);
    expect(p[5]).toBeCloseTo(f, 6);
    expect(p[10]).toBeCloseTo((far + near) / (near - far), 6);
    expect(p[11]).toBeCloseTo(-1, 6);
    expect(p[14]).toBeCloseTo((2 * far * near) / (near - far), 6);
  });

  it("near/far plane points map to NDC z = -1 / +1", () => {
    const p = perspective(60, 1, 1, 100);
    // point on -z axis at z=-near → NDC z = -1; at z=-far → +1.
    expectVecClose(transformPoint(p, vec3(0, 0, -1)), vec3(0, 0, -1));
    expectVecClose(transformPoint(p, vec3(0, 0, -100)), vec3(0, 0, 1));
  });
});

describe("orthographic — maps box to NDC", () => {
  it("corners map to NDC cube", () => {
    const o = orthographic(-2, 2, -2, 2, 1, 100);
    expectVecClose(transformPoint(o, vec3(2, 2, -1)), vec3(1, 1, -1));
    expectVecClose(transformPoint(o, vec3(-2, -2, -100)), vec3(-1, -1, 1));
  });
});

describe("invert", () => {
  it("M · M^-1 = I", () => {
    const M = localMatrix(vec3(5, 5, 0), vec3(100, 50, 10), vec3(10, 20, 30), vec3(2, 1.5, 1));
    const inv = invert(M);
    expect(inv).not.toBeNull();
    const prod = multiply(M, inv!);
    for (let i = 0; i < 16; i++) {
      expect(prod[i]).toBeCloseTo(identity()[i]!, 6);
    }
  });
});
