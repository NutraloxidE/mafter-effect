import { describe, expect, it } from "vitest";
import {
  collectVideoClipsFromComp,
  computeVideoLookaheadWarmupTargets,
  type VideoClipLookaheadInput,
} from "../src/runtime/videoLookaheadWarmup";
import type { TimelineComposition } from "../src/core/schema";

function clip(
  objectId: string,
  assetId: string,
  inPoint: number,
  opts?: Partial<VideoClipLookaheadInput>,
): VideoClipLookaheadInput {
  return {
    objectId,
    assetId,
    inPoint,
    outPoint: inPoint + 100,
    trimStart: 0,
    enabled: true,
    ...opts,
  };
}

describe("computeVideoLookaheadWarmupTargets", () => {
  it("returns empty when no clips or all already visible", () => {
    expect(computeVideoLookaheadWarmupTargets(60, 30, [])).toEqual([]);
    expect(
      computeVideoLookaheadWarmupTargets(60, 30, [clip("a", "assetA", 30)]),
    ).toEqual([]);
  });

  it("includes clip whose inPoint is within default 1s lookahead window", () => {
    const targets = computeVideoLookaheadWarmupTargets(50, 30, [
      clip("b", "assetB", 60, { trimStart: 15 }),
    ]);
    expect(targets).toEqual([
      { objectId: "b", assetId: "assetB", targetSec: 0.5, inPoint: 60 },
    ]);
  });

  it("excludes clip beyond lookahead window", () => {
    expect(
      computeVideoLookaheadWarmupTargets(0, 30, [clip("b", "assetB", 60)]),
    ).toEqual([]);
  });

  it("excludes disabled clips", () => {
    expect(
      computeVideoLookaheadWarmupTargets(50, 30, [
        clip("b", "assetB", 60, { enabled: false }),
      ]),
    ).toEqual([]);
  });

  it("excludes upcoming clip with same assetId as currently active", () => {
    expect(
      computeVideoLookaheadWarmupTargets(50, 30, [clip("b", "assetA", 60)], {
        activeAssetIds: new Set(["assetA"]),
      }),
    ).toEqual([]);
  });

  it("returns multiple different assets in inPoint order", () => {
    const targets = computeVideoLookaheadWarmupTargets(40, 30, [
      clip("c", "assetC", 70),
      clip("b", "assetB", 55),
    ]);
    expect(targets.map((t) => t.objectId)).toEqual(["b", "c"]);
  });

  it("respects custom lookaheadFrames", () => {
    expect(
      computeVideoLookaheadWarmupTargets(10, 30, [clip("b", "assetB", 20)], {
        lookaheadFrames: 15,
      }),
    ).toEqual([
      { objectId: "b", assetId: "assetB", targetSec: 0, inPoint: 20 },
    ]);
    expect(
      computeVideoLookaheadWarmupTargets(0, 30, [clip("b", "assetB", 20)], {
        lookaheadFrames: 15,
      }),
    ).toEqual([]);
  });

  it("includes loopStart-active clip near loopEnd using loopStart source time", () => {
    const targets = computeVideoLookaheadWarmupTargets(125, 30, [
      clip("looping", "assetA", 0, { outPoint: 150, trimStart: 15 }),
    ], {
      loop: { enabled: true, loopStart: 0, loopEnd: 150 },
    });
    expect(targets).toEqual([
      {
        objectId: "looping",
        assetId: "assetA",
        targetSec: 0.5,
        inPoint: 0,
        reason: "loop",
      },
    ]);
  });

  it("does not include loopStart-active clip outside the loop lookahead window", () => {
    expect(
      computeVideoLookaheadWarmupTargets(100, 30, [
        clip("looping", "assetA", 0, { outPoint: 150 }),
      ], {
        loop: { enabled: true, loopStart: 0, loopEnd: 150 },
      }),
    ).toEqual([]);
  });

  it("keeps loop disabled behavior identical to normal lookahead", () => {
    expect(
      computeVideoLookaheadWarmupTargets(125, 30, [
        clip("looping", "assetA", 0, { outPoint: 150 }),
      ], {
        loop: { enabled: false, loopStart: 0, loopEnd: 150 },
      }),
    ).toEqual([]);
  });

  it("excludes disabled and loopStart-out-of-range clips from loop warm-up", () => {
    expect(
      computeVideoLookaheadWarmupTargets(125, 30, [
        clip("disabled", "assetA", 0, { outPoint: 150, enabled: false }),
        clip("late", "assetB", 10, { outPoint: 150 }),
      ], {
        loop: { enabled: true, loopStart: 0, loopEnd: 150 },
      }),
    ).toEqual([]);
  });

  it("returns both normal cut and loop warm-up targets without duplicate object ids", () => {
    const targets = computeVideoLookaheadWarmupTargets(125, 30, [
      clip("upcoming", "assetB", 140),
      clip("looping", "assetA", 0, { outPoint: 150 }),
    ], {
      loop: { enabled: true, loopStart: 0, loopEnd: 150 },
    });
    expect(targets).toEqual([
      { objectId: "looping", assetId: "assetA", targetSec: 0, inPoint: 0, reason: "loop" },
      { objectId: "upcoming", assetId: "assetB", targetSec: 0, inPoint: 140 },
    ]);
  });
});

describe("collectVideoClipsFromComp", () => {
  it("extracts enabled video layers with trimStart", () => {
    const comp = {
      kind: "timeline",
      id: "comp1",
      name: "Main",
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 300,
      objects: [
        {
          id: "obj1",
          name: "V1",
          parent: null,
          zOrder: 1,
          enabled: true,
          inPoint: 0,
          outPoint: 100,
          transform: {
            anchor: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
            position: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
            rotation: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
            scale: { value: { x: 1, y: 1, z: 1 }, keyframes: [] },
          },
          opacity: { value: 1, keyframes: [] },
          components: [
            { type: "video", props: { asset: "assetV", trimStart: 30, footageQuality: "medium" } },
          ],
        },
        {
          id: "obj2",
          name: "Solid",
          parent: null,
          zOrder: 2,
          enabled: true,
          inPoint: 0,
          outPoint: 100,
          transform: {
            anchor: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
            position: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
            rotation: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
            scale: { value: { x: 1, y: 1, z: 1 }, keyframes: [] },
          },
          opacity: { value: 1, keyframes: [] },
          components: [{ type: "solid", props: {} }],
        },
      ],
    } as unknown as TimelineComposition;

    expect(collectVideoClipsFromComp(comp)).toEqual([
      {
        objectId: "obj1",
        assetId: "assetV",
        inPoint: 0,
        outPoint: 100,
        trimStart: 30,
        enabled: true,
        footageQuality: "medium",
      },
    ]);
  });
});
