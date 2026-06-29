import { describe, expect, it } from "vitest";
import { applyLinkedScaleDelta, applyLinkedScaleValue } from "../src/editor/linkedScale";

describe("applyLinkedScaleValue", () => {
  it("leaves Z unchanged when X/Y are linked", () => {
    const v = applyLinkedScaleValue({ x: 100, y: 50, z: 2 }, "x", 200, true);
    expect(v).toEqual({ x: 200, y: 100, z: 2 });
  });

  it("unlinked only changes the scrubbed axis", () => {
    const v = applyLinkedScaleValue({ x: 100, y: 50, z: 2 }, "x", 200, false);
    expect(v).toEqual({ x: 200, y: 50, z: 2 });
  });

  it("Z scrub is never linked", () => {
    const v = applyLinkedScaleValue({ x: 100, y: 50, z: 2 }, "z", 4, true);
    expect(v).toEqual({ x: 100, y: 50, z: 4 });
  });

  it("uses additive delta when starting scale is ~0", () => {
    const v = applyLinkedScaleValue({ x: 0, y: 10, z: 1 }, "x", 5, true);
    expect(v).toEqual({ x: 5, y: 15, z: 1 });
  });

  it("preserves negative scale via ratio", () => {
    const v = applyLinkedScaleValue({ x: -100, y: 50, z: 1 }, "x", -200, true);
    expect(v).toEqual({ x: -200, y: 100, z: 1 });
  });
});

describe("applyLinkedScaleDelta", () => {
  it("applies linked delta on Y", () => {
    const v = applyLinkedScaleDelta({ x: 100, y: 40, z: 1 }, "y", 20, true);
    expect(v).toEqual({ x: 150, y: 60, z: 1 });
  });
});
