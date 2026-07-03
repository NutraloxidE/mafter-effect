import { describe, expect, it } from "vitest";
import { rotationY } from "../src/runtime/mat4";
import {
  composeBaselineRotation,
  slamRotationToMafterEuler,
} from "../src/editor/motionTrack/coordConvert";
import { hornRotation, mat3ToQuaternion, type BearingPair, type Mat3 } from "../src/editor/motionTrack/rotationEstimator";

describe("slamRotationToMafterEuler", () => {
  it("identity quaternion maps to zero euler", () => {
    const e = slamRotationToMafterEuler([0, 0, 0, 1]);
    expect(e.x).toBeCloseTo(0, 3);
    expect(e.y).toBeCloseTo(0, 3);
    expect(e.z).toBeCloseTo(0, 3);
  });

  it("SLAM yaw (+Y rot) maps to Mafter rotation.y with same sign", () => {
    const deg = 12;
    const rad = (deg * Math.PI) / 180;
    const R: Mat3 = [
      [Math.cos(rad), 0, Math.sin(rad)],
      [0, 1, 0],
      [-Math.sin(rad), 0, Math.cos(rad)],
    ];
    const q = mat3ToQuaternion(R);
    const e = slamRotationToMafterEuler(q);
    expect(e.y).toBeCloseTo(deg, 1);
    expect(Math.abs(e.x)).toBeLessThan(0.5);
    expect(Math.abs(e.z)).toBeLessThan(0.5);
  });

  it("pitch sign is negated under Z-flip conjugation", () => {
    const pitchDeg = 8;
    const rad = (pitchDeg * Math.PI) / 180;
    const R: Mat3 = [
      [1, 0, 0],
      [0, Math.cos(rad), -Math.sin(rad)],
      [0, Math.sin(rad), Math.cos(rad)],
    ];
    const q = mat3ToQuaternion(R);
    const e = slamRotationToMafterEuler(q);
    expect(Math.abs(e.x)).toBeCloseTo(pitchDeg, 1);
  });

  it("composeBaselineRotation adds relative yaw to baseline", () => {
    const baseline = { x: 0, y: 5, z: 0 };
    const pairs: BearingPair[] = Array.from({ length: 20 }, (_, i) => {
      const a: [number, number, number] = [0, 0, 1];
      const ang = ((i + 1) * 2 * Math.PI) / 180;
      const b: [number, number, number] = [Math.sin(ang), 0, Math.cos(ang)];
      return [a, b];
    });
    const q = mat3ToQuaternion(hornRotation(pairs));
    const baked = composeBaselineRotation(baseline, q);
    expect(baked.y).toBeGreaterThan(baseline.y);
  });

  it("composeBaselineRotation matches rotationY for pure yaw", () => {
    const deg = 15;
    const m = rotationY(deg);
    const R: Mat3 = [
      [m[0], m[1], m[2]],
      [m[4], m[5], m[6]],
      [m[8], m[9], m[10]],
    ];
    const q = mat3ToQuaternion(R);
    const baked = composeBaselineRotation({ x: 0, y: 0, z: 0 }, q);
    expect(Math.abs(baked.y)).toBeCloseTo(deg, 1);
  });
});
