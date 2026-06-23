import { describe, expect, it } from "vitest";
import { defaultTransform, staticProp, vec3 } from "../src/core/props";
import type { SceneObject, TimelineComposition } from "../src/core/schema";
import { buildReparentPatch, worldOriginAtFrame } from "../src/editor/reparent";

function atPos(id: string, pos: { x: number; y: number; z?: number }, parent: string | null = null): SceneObject {
  const t = defaultTransform();
  t.position = staticProp(vec3(pos.x, pos.y, pos.z ?? 0));
  return {
    id,
    name: id,
    parent,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 100,
    transform: t,
    opacity: staticProp(1),
    components: [],
  };
}

function comp(objects: SceneObject[]): TimelineComposition {
  return {
    id: "C",
    name: "Main",
    kind: "timeline",
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 100,
    objects,
  };
}

describe("buildReparentPatch", () => {
  it("preserves world origin when parenting to null layer", () => {
    const nullLayer = atPos("n", { x: 500, y: 300 });
    nullLayer.isNull = true;
    nullLayer.components = [];
    const solid = atPos("s", { x: 100, y: 50 });
    const c = comp([nullLayer, solid]);

    const before = worldOriginAtFrame(c, "s", 0)!;
    const patch = buildReparentPatch(c, solid, "n", 0);
    expect(patch).not.toBeNull();

    const afterObj: SceneObject = { ...solid, ...patch! };
    const c2 = comp([nullLayer, afterObj]);
    const after = worldOriginAtFrame(c2, "s", 0)!;

    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
  });

  it("returns null when parent unchanged", () => {
    const solid = atPos("s", { x: 10, y: 20 }, "p");
    const parent = atPos("p", { x: 0, y: 0 });
    const c = comp([parent, solid]);
    expect(buildReparentPatch(c, solid, "p", 0)).toBeNull();
  });

  it("updates animated position at current frame", () => {
    const nullLayer = atPos("n", { x: 0, y: 0 });
    nullLayer.isNull = true;
    const solid = atPos("s", { x: 100, y: 0 });
    solid.transform.position = {
      value: { x: 0, y: 0, z: 0 },
      keyframes: [{ frame: 0, value: { x: 100, y: 0, z: 0 }, easing: { type: "linear" } }],
    };
    const c = comp([nullLayer, solid]);
    const patch = buildReparentPatch(c, solid, "n", 0);
    expect(patch?.transform.position.keyframes).toHaveLength(1);
    expect(patch?.transform.position.keyframes[0]?.frame).toBe(0);
  });

  // 回帰: KF 付きレイヤーを static Null へ親付けしても world が全フレームで保たれる
  // （旧実装は現フレームの 1 KF のみ補正 → 他フレームでずれていた）。
  it("preserves world at ALL keyframes (and between them) when parenting to a static null", () => {
    const nullLayer = atPos("n", { x: 960, y: 540 }); // comp 中心相当の static Null
    nullLayer.isNull = true;
    nullLayer.components = [];

    const solid = atPos("s", { x: 0, y: 0 });
    // 画面を横断する position KF（0/15/30 で互いに離れた絶対位置・linear）。
    solid.transform.position = {
      value: { x: 0, y: 0, z: 0 },
      keyframes: [
        { frame: 0, value: { x: 100, y: 200, z: 0 }, easing: { type: "linear" } },
        { frame: 15, value: { x: 800, y: 600, z: 0 }, easing: { type: "linear" } },
        { frame: 30, value: { x: 1500, y: 100, z: 0 }, easing: { type: "linear" } },
      ],
    };
    const c = comp([nullLayer, solid]);

    // KF frame と KF 間（7/22）両方で親付け前の world を記録。
    const checkFrames = [0, 7, 15, 22, 30];
    const before = checkFrames.map((f) => worldOriginAtFrame(c, "s", f)!);

    // frame 0 で Null へ親付け。
    const patch = buildReparentPatch(c, solid, "n", 0);
    expect(patch).not.toBeNull();
    expect(patch!.parent).toBe("n");
    // KF 位置と本数は不変（補正は value のみ）。
    expect(patch!.transform.position.keyframes.map((k) => k.frame)).toEqual([0, 15, 30]);

    const afterObj: SceneObject = { ...solid, ...patch! };
    const c2 = comp([nullLayer, afterObj]);

    checkFrames.forEach((f, i) => {
      const after = worldOriginAtFrame(c2, "s", f)!;
      const expected = before[i]!;
      expect(after.x).toBeCloseTo(expected.x, 4);
      expect(after.y).toBeCloseTo(expected.y, 4);
    });
  });

  it("preserves keyframe easing when reparenting (only value is rewritten)", () => {
    const nullLayer = atPos("n", { x: 300, y: 300 });
    nullLayer.isNull = true;
    const bez: SceneObject["transform"]["position"]["keyframes"][number]["easing"] = {
      type: "bezier",
      bezier: [0.42, 0, 0.58, 1],
    };
    const solid = atPos("s", { x: 0, y: 0 });
    solid.transform.position = {
      value: { x: 0, y: 0, z: 0 },
      keyframes: [
        { frame: 0, value: { x: 10, y: 20, z: 0 }, easing: bez },
        { frame: 20, value: { x: 400, y: 500, z: 0 }, easing: { type: "linear" } },
      ],
    };
    const c = comp([nullLayer, solid]);
    const patch = buildReparentPatch(c, solid, "n", 0);
    expect(patch?.transform.position.keyframes[0]?.easing).toEqual(bez);
  });
});
