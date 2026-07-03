import { describe, expect, it } from "vitest";
import { makeProjectionPair, triangulateLinear } from "../src/editor/motionTrack/triangulate";
import { solvePnPDlt } from "../src/editor/motionTrack/pnp";
import { MultiFrameVoState } from "../src/editor/motionTrack/multiFrameVo";
import { composeRelativeStep, identityInternalPose } from "../src/editor/motionTrack/poseGate";

describe("triangulateLinear", () => {
  it("recovers a point in front of two cameras", () => {
    const R = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const t = [0.5, 0, 0];
    const { P0, P1 } = makeProjectionPair(R, t);
    const rec = triangulateLinear(P0, P1, 0, 0, 0.25, 0);
    expect(rec).not.toBeNull();
    expect(Number.isFinite(rec![2]!)).toBe(true);
    expect(rec![2]!).toBeGreaterThan(0.5);
  });
});

describe("solvePnPDlt", () => {
  it("recovers identity pose for points in cam0", () => {
    const world: Array<[number, number, number]> = [];
    const norms: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 10; i++) {
      const X = [(i % 3) - 1, Math.floor(i / 3) - 1, 2 + (i % 2) * 0.3] as [
        number,
        number,
        number,
      ];
      world.push(X);
      norms.push({ x: X[0] / X[2], y: X[1] / X[2] });
    }
    const pose = solvePnPDlt(world, norms);
    expect(pose).not.toBeNull();
    expect(Math.abs(pose!.t[2]!)).toBeLessThan(1);
  });
});

describe("MultiFrameVoState continuity", () => {
  it("emits relative steps without large jumps on expansion flow", () => {
    const vo = new MultiFrameVoState();
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 16; i++) {
      const ang = (i / 16) * Math.PI * 2;
      pts.push({ x: 320 + Math.cos(ang) * 40, y: 240 + Math.sin(ang) * 40 });
    }
    const ids = vo.seedFrame0(pts);

    const jumps: number[] = [];
    let pose = identityInternalPose();
    for (let f = 1; f <= 12; f++) {
      const r0 = 40 + (f - 1);
      const r1 = 40 + f;
      const pairs = pts.map((_, i) => {
        const ang = (i / 16) * Math.PI * 2;
        return {
          id: ids[i]!,
          x0: 320 + Math.cos(ang) * r0,
          y0: 240 + Math.sin(ang) * r0,
          x1: 320 + Math.cos(ang) * r1,
          y1: 240 + Math.sin(ang) * r1,
        };
      });
      const { step } = vo.processFrame(f, pairs, [], 640, 480, 500);
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
  });

  it("never emits absolute pose switch (always returns a step)", () => {
    const vo = new MultiFrameVoState();
    const ids = vo.seedFrame0([
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 100, y: 200 },
      { x: 200, y: 200 },
      { x: 150, y: 150 },
      { x: 180, y: 160 },
      { x: 120, y: 180 },
      { x: 220, y: 140 },
    ]);
    const pairs = ids.map((id, i) => ({
      id,
      x0: 100 + i * 10,
      y0: 100,
      x1: 100 + i * 10 + 2,
      y1: 102,
    }));
    const out = vo.processFrame(1, pairs, [], 640, 480, 500);
    expect(out.step.scale).toBeGreaterThan(0);
    expect(out.pnpAccepted).toBe(false);
  });
});
