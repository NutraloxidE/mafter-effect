import { describe, expect, it } from "vitest";
import { defaultTransform, staticProp, vec3 } from "../src/core/props";
import type { SceneObject, TimelineComposition } from "../src/core/schema";
import { createProject } from "../src/core/createProject";
import {
  applyCombinedTrackToObject,
  applyCombinedTrackToProject,
  applyMotionTrackToObject,
  applyMotionTrackToProject,
  applyRotationTrackToObject,
  bakePositionKeyframes,
  bakeRotationKeyframes,
  targetHasPositionExpression,
  targetHasRotationExpression,
} from "../src/editor/motionTrack/applyMotionTrack";
import { smoothTranslations, smoothRotations } from "../src/editor/motionTrack/smoothPoses";
import type { RawQuaternion, RawTranslation } from "../src/editor/motionTrack/types";

function makeTarget(id: string, over?: Partial<SceneObject>): SceneObject {
  const t = defaultTransform();
  t.position = staticProp(vec3(100, 200, 50));
  return {
    id,
    name: id,
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 60,
    transform: t,
    opacity: staticProp(1),
    components: [],
    ...over,
  };
}

describe("smoothPoses", () => {
  it("median-filters jitter and rejects single outlier spike", () => {
    const input: Array<RawTranslation | null> = [
      [0, 0, 0],
      [0.01, 0, 0],
      [0.5, 0, 0],
      [0.02, 0, 0],
      [0.03, 0, 0],
    ];
    const out = smoothTranslations(input, { outlierThreshold: 0.2 });
    expect(out.length).toBe(5);
    expect(out[2]![0]).toBeLessThan(0.2);
    expect(out[3]![0]).toBeCloseTo(out[2]![0], 1);
  });
});

describe("smoothRotations", () => {
  it("median-filters quaternion jitter", () => {
    const input: Array<RawQuaternion | null> = [
      [0, 0, 0, 1],
      [0, 0.01, 0, 0.9999],
      [0, 0.5, 0, 0.866],
      [0, 0.012, 0, 0.9999],
      [0, 0.015, 0, 0.9999],
    ];
    const out = smoothRotations(input, { outlierThresholdDeg: 30 });
    expect(out.length).toBe(5);
    expect(Math.abs(out[2]![1])).toBeLessThan(0.2);
  });
});

describe("applyRotationTrack", () => {
  it("bakeRotationKeyframes replaces in-range keyframes", () => {
    const target = makeTarget("null", { isNull: true });
    target.transform.rotation = {
      value: vec3(0, 0, 0),
      keyframes: [
        { frame: 0, value: vec3(0, 0, 0), easing: { type: "linear" } },
        { frame: 5, value: vec3(0, 5, 0), easing: { type: "linear" } },
        { frame: 20, value: vec3(0, 20, 0), easing: { type: "linear" } },
      ],
    };
    const rotations = new Map<number, ReturnType<typeof vec3>>([
      [5, vec3(0, 10, 0)],
      [10, vec3(0, 12, 0)],
    ]);
    const next = bakeRotationKeyframes(target.transform.rotation, {
      baselineRotation: vec3(0, 0, 0),
      rotationsByFrame: rotations,
      bakeStart: 5,
      bakeEnd: 15,
      clearExpression: false,
    });
    expect(next.keyframes.find((k) => k.frame === 5)!.value.y).toBe(10);
    expect(next.keyframes.find((k) => k.frame === 20)!.value.y).toBe(20);
  });

  it("clears rotation expression in same patch", () => {
    const target = makeTarget("null", { isNull: true });
    target.transform.rotation = {
      value: vec3(0, 0, 0),
      keyframes: [],
      expression: { path: "scripts/x/rotation.js", enabled: true },
    };
    expect(targetHasRotationExpression(target)).toBe(true);
    const next = bakeRotationKeyframes(target.transform.rotation, {
      baselineRotation: vec3(0, 0, 0),
      rotationsByFrame: new Map([[0, vec3(0, 0, 0)]]),
      bakeStart: 0,
      bakeEnd: 10,
      clearExpression: true,
    });
    expect(next.expression).toBeUndefined();
  });

  it("applyRotationTrackToObject patches rotation only", () => {
    const target = makeTarget("null", { isNull: true });
    const next = applyRotationTrackToObject(target, {
      baselineRotation: vec3(0, 0, 0),
      rotationsByFrame: new Map([[10, vec3(0, 15, 0)]]),
      bakeStart: 0,
      bakeEnd: 30,
      clearExpression: false,
    });
    expect(next.transform.rotation.keyframes).toHaveLength(1);
    expect(next.transform.position).toEqual(target.transform.position);
  });
});

describe("applyMotionTrack", () => {
  it("replaces keyframes in bake range and keeps outside", () => {
    const target = makeTarget("cam");
    target.transform.position = {
      value: vec3(0, 0, 0),
      keyframes: [
        { frame: 0, value: vec3(0, 0, 0), easing: { type: "linear" } },
        { frame: 5, value: vec3(5, 0, 0), easing: { type: "linear" } },
        { frame: 20, value: vec3(20, 0, 0), easing: { type: "linear" } },
      ],
    };
    const positions = new Map<number, ReturnType<typeof vec3>>([
      [5, vec3(50, 0, 0)],
      [10, vec3(60, 0, 0)],
    ]);
    const next = applyMotionTrackToObject(target, {
      baselinePosition: vec3(100, 200, 50),
      positionsByFrame: positions,
      bakeStart: 5,
      bakeEnd: 15,
      clearExpression: false,
    });
    const frames = next.transform.position.keyframes.map((k) => k.frame);
    expect(frames).toContain(0);
    expect(frames).toContain(5);
    expect(frames).toContain(10);
    expect(frames).toContain(20);
    expect(frames).not.toContain(7);
    expect(next.transform.position.keyframes.find((k) => k.frame === 5)!.value.x).toBe(50);
    expect(next.transform.position.keyframes.find((k) => k.frame === 20)!.value.x).toBe(20);
  });

  it("clears expression in the same bake patch", () => {
    const target = makeTarget("null", { isNull: true });
    target.transform.position = {
      value: vec3(1, 2, 3),
      keyframes: [],
      expression: { path: "scripts/x/position.js", enabled: true },
    };
    expect(targetHasPositionExpression(target)).toBe(true);
    const next = bakePositionKeyframes(target.transform.position, {
      baselinePosition: vec3(1, 2, 3),
      positionsByFrame: new Map([[0, vec3(1, 2, 3)]]),
      bakeStart: 0,
      bakeEnd: 10,
      clearExpression: true,
    });
    expect(next.expression).toBeUndefined();
    expect(next.keyframes).toHaveLength(1);
  });

  it("applyMotionTrackToProject produces single-object undo patch", () => {
    const project = createProject();
    const comp = project.compositions[0] as TimelineComposition;
    const target = makeTarget("t1", { isNull: true });
    comp.objects = [target];
    const { before, after } = applyMotionTrackToProject(project, comp.id, "t1", {
      baselinePosition: vec3(100, 200, 50),
      positionsByFrame: new Map([
        [0, vec3(100, 200, 50)],
        [10, vec3(110, 200, 50)],
      ]),
      bakeStart: 0,
      bakeEnd: 30,
      clearExpression: false,
    });
    const afterObj = (after.compositions[0] as TimelineComposition).objects[0]!;
    expect(afterObj.transform.position.keyframes).toHaveLength(2);
    expect(before).not.toBe(after);
    expect(before.compositions[0]).not.toBe(after.compositions[0]);
  });
});

describe("applyCombinedTrack", () => {
  it("patches position and rotation in one object", () => {
    const target = makeTarget("null", { isNull: true });
    const next = applyCombinedTrackToObject(
      target,
      {
        baselinePosition: vec3(100, 200, 50),
        positionsByFrame: new Map([[10, vec3(110, 200, 50)]]),
        bakeStart: 0,
        bakeEnd: 30,
        clearExpression: false,
      },
      {
        baselineRotation: vec3(0, 0, 0),
        rotationsByFrame: new Map([[10, vec3(0, 15, 0)]]),
        bakeStart: 0,
        bakeEnd: 30,
        clearExpression: false,
      },
    );
    expect(next.transform.position.keyframes).toHaveLength(1);
    expect(next.transform.rotation.keyframes).toHaveLength(1);
    expect(next.transform.rotation.keyframes[0]!.value.y).toBe(15);
  });

  it("applyCombinedTrackToProject produces single undo patch", () => {
    const project = createProject();
    const comp = project.compositions[0] as TimelineComposition;
    const target = makeTarget("t1", { isNull: true });
    comp.objects = [target];
    const { before, after } = applyCombinedTrackToProject(
      project,
      comp.id,
      "t1",
      {
        baselinePosition: vec3(100, 200, 50),
        positionsByFrame: new Map([[10, vec3(110, 200, 50)]]),
        bakeStart: 0,
        bakeEnd: 30,
        clearExpression: false,
      },
      {
        baselineRotation: vec3(0, 0, 0),
        rotationsByFrame: new Map([[10, vec3(0, 15, 0)]]),
        bakeStart: 0,
        bakeEnd: 30,
        clearExpression: false,
      },
    );
    const afterObj = (after.compositions[0] as TimelineComposition).objects[0]!;
    expect(afterObj.transform.position.keyframes).toHaveLength(1);
    expect(afterObj.transform.rotation.keyframes).toHaveLength(1);
    expect(before).not.toBe(after);
  });
});
