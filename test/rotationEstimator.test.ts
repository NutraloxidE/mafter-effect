import { describe, expect, it } from "vitest";
import {
  bearingFromPixel,
  estimateRotationFromPairs,
  hornRotation,
  mat3ToQuaternion,
  quaternionMultiply,
  ransacRotation,
  type Mat3,
} from "../src/editor/motionTrack/rotationEstimator";

function Ry(t: number): Mat3 {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ];
}

function applyR(R: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    R[0]![0]! * v[0] + R[0]![1]! * v[1] + R[0]![2]! * v[2],
    R[1]![0]! * v[0] + R[1]![1]! * v[1] + R[1]![2]! * v[2],
    R[2]![0]! * v[0] + R[2]![1]! * v[1] + R[2]![2]! * v[2],
  ];
}

describe("rotationEstimator", () => {
  it("bearingFromPixel normalizes to unit length", () => {
    const b = bearingFromPixel(400, 300, 500, 500, 320, 240);
    const n = Math.hypot(b[0], b[1], b[2]);
    expect(n).toBeCloseTo(1, 5);
  });

  it("hornRotation recovers known yaw delta on synthetic pairs", () => {
    const yaw = 0.01;
    const pairs: Array<[[number, number, number], [number, number, number]]> = [];
    for (let i = 0; i < 80; i++) {
      const dir: [number, number, number] = [
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2,
        1 + Math.random(),
      ];
      const n = Math.hypot(dir[0], dir[1], dir[2]);
      const a: [number, number, number] = [dir[0] / n, dir[1] / n, dir[2] / n];
      const b3 = applyR(Ry(yaw), a);
      const nb = Math.hypot(b3[0], b3[1], b3[2]);
      const b: [number, number, number] = [b3[0] / nb, b3[1] / nb, b3[2] / nb];
      pairs.push([a, b]);
    }
    const R = hornRotation(pairs);
    const estYaw = Math.atan2(R[0][2], R[0][0]);
    expect(estYaw).toBeCloseTo(yaw, 3);
  });

  it("ransacRotation finds yaw on clean pairs", () => {
    const yaw = 0.02;
    const pairs: Array<[[number, number, number], [number, number, number]]> = [];
    for (let i = 0; i < 50; i++) {
      const dir: [number, number, number] = [
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2,
        1 + Math.random(),
      ];
      const n = Math.hypot(dir[0], dir[1], dir[2]);
      const a: [number, number, number] = [dir[0] / n, dir[1] / n, dir[2] / n];
      const b3 = applyR(Ry(yaw), a);
      const nb = Math.hypot(b3[0], b3[1], b3[2]);
      pairs.push([a, [b3[0] / nb, b3[1] / nb, b3[2] / nb]]);
    }
    const fit = ransacRotation(pairs, { seed: 1 });
    expect(fit).not.toBeNull();
    expect(fit!.inlierRatio).toBeGreaterThan(0.9);
    const estYaw = Math.atan2(fit!.R[0][2], fit!.R[0][0]);
    expect(estYaw).toBeCloseTo(yaw, 2);
  });

  it("estimateRotationFromPairs returns unit quaternion", () => {
    const yaw = 0.015;
    const pairs: Array<[[number, number, number], [number, number, number]]> = [];
    for (let i = 0; i < 40; i++) {
      const dir: [number, number, number] = [
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2,
        1 + Math.random(),
      ];
      const n = Math.hypot(dir[0], dir[1], dir[2]);
      const a: [number, number, number] = [dir[0] / n, dir[1] / n, dir[2] / n];
      const b3 = applyR(Ry(yaw), a);
      const nb = Math.hypot(b3[0], b3[1], b3[2]);
      pairs.push([a, [b3[0] / nb, b3[1] / nb, b3[2] / nb]]);
    }
    const est = estimateRotationFromPairs(pairs);
    expect(est).not.toBeNull();
    const n = Math.hypot(est!.quaternion[0], est!.quaternion[1], est!.quaternion[2], est!.quaternion[3]);
    expect(n).toBeCloseTo(1, 4);
  });

  it("quaternionMultiply composes rotations", () => {
    const qy = mat3ToQuaternion(Ry(0.1));
    const qid = mat3ToQuaternion(Ry(0));
    const q = quaternionMultiply(qy, qid);
    expect(q[3]).toBeCloseTo(qy[3], 3);
  });
});
