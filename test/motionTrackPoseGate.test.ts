import { describe, expect, it } from "vitest";
import {
  acceptPnpRelative,
  composeRelativeStep,
  emaFilterStep,
  identityInternalPose,
  motionCosine,
  quaternionAngleDeg,
} from "../src/editor/motionTrack/poseGate";
import type { WalkRelative } from "../src/editor/motionTrack/walkAccumulate";

const id: WalkRelative = {
  rotation: [0, 0, 0, 1],
  motion: [0, 0, 1],
  scale: 10,
};

describe("acceptPnpRelative", () => {
  it("keeps pred when rotation differs a lot", () => {
    // ~90° about X
    const pnp: WalkRelative = {
      rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      motion: [0, 0, 1],
      scale: 99,
    };
    const out = acceptPnpRelative(id, pnp);
    expect(out).toBe(id);
    expect(out.scale).toBe(10);
  });

  it("accepts pnp orientation but uses pred.scale", () => {
    const pnp: WalkRelative = {
      rotation: [0, 0, 0, 1],
      motion: [0, 0, 1],
      scale: 99,
    };
    const out = acceptPnpRelative(id, pnp);
    expect(out.scale).toBe(10);
    expect(out.motion[2]).toBe(1);
  });

  it("rejects opposite motion direction", () => {
    const pnp: WalkRelative = {
      rotation: [0, 0, 0, 1],
      motion: [0, 0, -1],
      scale: 10,
    };
    expect(acceptPnpRelative(id, pnp)).toBe(id);
  });
});

describe("emaFilterStep", () => {
  it("blends toward current", () => {
    const prev: WalkRelative = { rotation: [0, 0, 0, 1], motion: [1, 0, 0], scale: 10 };
    const cur: WalkRelative = { rotation: [0, 0, 0, 1], motion: [0, 1, 0], scale: 20 };
    const out = emaFilterStep(prev, cur, 0.5);
    expect(out.scale).toBeCloseTo(15, 5);
    expect(out.motion[0]).toBeCloseTo(out.motion[1]!, 5);
  });
});

describe("composeRelativeStep", () => {
  it("accumulates without jump on identity rotation", () => {
    let pose = identityInternalPose();
    const step: WalkRelative = { rotation: [0, 0, 0, 1], motion: [0, 0, 1], scale: 5 };
    const jumps: number[] = [];
    for (let i = 0; i < 10; i++) {
      const next = composeRelativeStep(pose, step);
      jumps.push(
        Math.hypot(
          next.center[0] - pose.center[0],
          next.center[1] - pose.center[1],
          next.center[2] - pose.center[2],
        ),
      );
      pose = next;
    }
    const med = [...jumps].sort((a, b) => a - b)[Math.floor(jumps.length / 2)]!;
    const max = Math.max(...jumps);
    expect(max).toBeLessThanOrEqual(med * 3 + 1e-6);
    expect(pose.center[2]).toBeCloseTo(50, 5);
  });
});

describe("quaternionAngleDeg / motionCosine", () => {
  it("identity angle is 0", () => {
    expect(quaternionAngleDeg([0, 0, 0, 1], [0, 0, 0, 1])).toBeCloseTo(0, 5);
  });

  it("parallel motions have cos 1", () => {
    expect(motionCosine([0, 0, 1], [0, 0, 2])).toBeCloseTo(1, 5);
  });
});
