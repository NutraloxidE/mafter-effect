import { describe, expect, it } from "vitest";
import {
  addVec3,
  rawTranslationToMafterDelta,
  slamTranslationToMafterDelta,
  subVec3,
} from "../src/editor/motionTrack/coordConvert";

describe("motionTrack coordConvert", () => {
  it("maps +x pan unchanged", () => {
    const v = slamTranslationToMafterDelta(1, 0, 0, 1);
    expect(v).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("maps +y unchanged", () => {
    const v = slamTranslationToMafterDelta(0, 2, 0, 1);
    expect(v).toEqual({ x: 0, y: 2, z: 0 });
  });

  it("flips +z scene-forward to Mafter -z (viewer-forward)", () => {
    const v = slamTranslationToMafterDelta(0, 0, 3, 1);
    expect(v).toEqual({ x: 0, y: 0, z: -3 });
  });

  it("applies userScale to all axes including flipped z", () => {
    const v = slamTranslationToMafterDelta(1, -2, 4, 2.5);
    expect(v).toEqual({ x: 2.5, y: -5, z: -10 });
  });

  it("rawTranslationToMafterDelta matches spike sample pan", () => {
    const v = rawTranslationToMafterDelta([0.0266, 0, 0], 1);
    expect(v.x).toBeCloseTo(0.0266, 5);
    expect(v.y).toBe(0);
    expect(v.z).toBe(0);
  });

  it("rawTranslationToMafterDelta matches spike dolly +z", () => {
    const v = rawTranslationToMafterDelta([0.0006, -0.0005, 0.0218], 1);
    expect(v.x).toBeCloseTo(0.0006, 5);
    expect(v.y).toBeCloseTo(-0.0005, 5);
    expect(v.z).toBeCloseTo(-0.0218, 5);
  });

  it("addVec3 / subVec3 are component-wise", () => {
    const a = { x: 10, y: 20, z: 30 };
    const b = { x: 1, y: 2, z: 3 };
    expect(addVec3(a, b)).toEqual({ x: 11, y: 22, z: 33 });
    expect(subVec3(a, b)).toEqual({ x: 9, y: 18, z: 27 });
  });
});
