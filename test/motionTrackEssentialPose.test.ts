import { describe, expect, it } from "vitest";
import { medianFlowPx, type PixelPair } from "../src/editor/motionTrack/essentialPose";
import { estimateWalkStepFromFlow } from "../src/editor/motionTrack/flowWalk";
import { accumulateWalkTrajectory, type WalkRelative } from "../src/editor/motionTrack/walkAccumulate";

describe("medianFlowPx", () => {
  it("reflects pixel motion", () => {
    const pairs: PixelPair[] = [
      { x0: 0, y0: 0, x1: 3, y1: 4 },
      { x0: 0, y0: 0, x1: 6, y1: 8 },
    ];
    expect(medianFlowPx(pairs)).toBeCloseTo(7.5, 5);
  });
});

describe("estimateWalkStepFromFlow", () => {
  it("detects forward expansion as +z motion", () => {
    const pairs: PixelPair[] = [];
    for (let i = 0; i < 16; i++) {
      const ang = (i / 16) * Math.PI * 2;
      const r0 = 40;
      const r1 = 50;
      pairs.push({
        x0: 320 + Math.cos(ang) * r0,
        y0: 240 + Math.sin(ang) * r0,
        x1: 320 + Math.cos(ang) * r1,
        y1: 240 + Math.sin(ang) * r1,
      });
    }
    const step = estimateWalkStepFromFlow(pairs, 640, 480, 500);
    expect(step).not.toBeNull();
    expect(step!.motion[2]!).toBeGreaterThan(0.5);
  });

  it("maps downward feature flow to negative pitch (camera tilt up)", () => {
    const pairs: PixelPair[] = [];
    for (let i = 0; i < 12; i++) {
      const x = 100 + i * 30;
      pairs.push({ x0: x, y0: 200, x1: x, y1: 210 });
    }
    const step = estimateWalkStepFromFlow(pairs, 640, 480, 500);
    expect(step).not.toBeNull();
    // 特徴が下へ → カメラは上向き → pitch < 0（qx < 0）
    expect(step!.rotation[0]!).toBeLessThan(-0.001);
  });
});

describe("accumulateWalkTrajectory", () => {
  it("accumulates forward motion into position", () => {
    const step: WalkRelative = {
      rotation: [0, 0, 0, 1],
      motion: [0, 0, 1],
      scale: 10,
    };
    const relatives: Array<WalkRelative | null> = [null, step, step, step];
    const { positions, validMask } = accumulateWalkTrajectory(
      relatives,
      { x: 960, y: 540, z: 1000 },
      { x: 0, y: 0, z: 0 },
      1,
    );
    expect(validMask[0]).toBe(true);
    expect(validMask[1]).toBe(true);
    expect(positions[3]!.z).toBeLessThan(positions[0]!.z);
    expect(positions[0]!.z - positions[3]!.z).toBeCloseTo(30, 5);
  });

  it("holds on null relatives", () => {
    const step: WalkRelative = {
      rotation: [0, 0, 0, 1],
      motion: [1, 0, 0],
      scale: 5,
    };
    const { positions, validMask } = accumulateWalkTrajectory(
      [null, step, null],
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      1,
    );
    expect(validMask[2]).toBe(false);
    expect(positions[2]).toEqual(positions[1]);
  });
});
