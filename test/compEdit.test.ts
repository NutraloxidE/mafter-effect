import { describe, expect, it } from "vitest";
import {
  offsetVec3PropXY,
  rescaleCompFps,
  rescalePropFrames,
  resizeCompCentered,
} from "../src/editor/compEdit";
import type { AnimatedProp, SceneObject, TimelineComposition, Vec3 } from "../src/core/schema";

const lin = { type: "linear" } as const;
const sp = <T>(value: T): AnimatedProp<T> => ({ value, keyframes: [] });

function obj(id: string, parent: string | null, posX: number): SceneObject {
  return {
    id,
    name: id,
    enabled: true,
    parent,
    zOrder: 1,
    inPoint: 0,
    outPoint: 30,
    transform: {
      anchor: sp({ x: 0, y: 0, z: 0 }),
      position: sp({ x: posX, y: 0, z: 5 }),
      rotation: sp({ x: 0, y: 0, z: 0 }),
      scale: sp({ x: 1, y: 1, z: 1 }),
    },
    opacity: sp(1),
    components: [],
    effects: [],
  };
}

function comp(objects: SceneObject[]): TimelineComposition {
  return {
    id: "C1",
    name: "Comp",
    kind: "timeline",
    width: 1000,
    height: 500,
    fps: 30,
    duration: 60,
    objects,
  };
}

describe("offsetVec3PropXY", () => {
  it("base 値と全 KF の x/y を移動し z は不変", () => {
    const prop: AnimatedProp<Vec3> = {
      value: { x: 10, y: 20, z: 99 },
      keyframes: [{ frame: 5, value: { x: 1, y: 2, z: 3 }, easing: lin }],
    };
    const out = offsetVec3PropXY(prop, 100, 50);
    expect(out.value).toEqual({ x: 110, y: 70, z: 99 });
    expect(out.keyframes[0]!.value).toEqual({ x: 101, y: 52, z: 3 });
  });

  it("dx=dy=0 は同一参照を返す", () => {
    const prop = sp({ x: 0, y: 0, z: 0 });
    expect(offsetVec3PropXY(prop, 0, 0)).toBe(prop);
  });
});

describe("rescalePropFrames", () => {
  it("frame を round(*ratio) にする", () => {
    const prop: AnimatedProp<number> = {
      value: 0,
      keyframes: [
        { frame: 0, value: 0, easing: lin },
        { frame: 10, value: 1, easing: lin },
        { frame: 30, value: 2, easing: lin },
      ],
    };
    const out = rescalePropFrames(prop, 2);
    expect(out.keyframes.map((k) => k.frame)).toEqual([0, 20, 60]);
  });

  it("丸めで衝突した frame は後勝ち統合し昇順維持", () => {
    const prop: AnimatedProp<number> = {
      value: 0,
      keyframes: [
        { frame: 1, value: 10, easing: lin },
        { frame: 2, value: 20, easing: lin },
      ],
    };
    // ratio 0.4: round(0.4)=0, round(0.8)=1 → 衝突なし
    const out = rescalePropFrames(prop, 0.4);
    expect(out.keyframes.map((k) => k.frame)).toEqual([0, 1]);
  });

  it("ratio=1 は同一参照", () => {
    const prop: AnimatedProp<number> = { value: 0, keyframes: [{ frame: 5, value: 1, easing: lin }] };
    expect(rescalePropFrames(prop, 1)).toBe(prop);
  });
});

describe("resizeCompCentered", () => {
  it("parent===null のレイヤーのみ position を中央オフセット", () => {
    const root = obj("root", null, 100);
    const child = obj("child", "root", 100);
    const out = resizeCompCentered(comp([root, child]), 1200, 700);
    // dx=(1200-1000)/2=100, dy=(700-500)/2=100
    expect(out.objects[0]!.transform.position.value).toEqual({ x: 200, y: 100, z: 5 });
    // child は不変（parent 継承で追従）
    expect(out.objects[1]!.transform.position.value).toEqual({ x: 100, y: 0, z: 5 });
    expect(out.width).toBe(1200);
    expect(out.height).toBe(700);
  });

  it("width/height は >=1 整数に丸め", () => {
    const out = resizeCompCentered(comp([obj("a", null, 0)]), 0.4, 100.6);
    expect(out.width).toBe(1);
    expect(out.height).toBe(101);
  });

  it("サイズ不変なら同一参照", () => {
    const c = comp([obj("a", null, 0)]);
    expect(resizeCompCentered(c, 1000, 500)).toBe(c);
  });
});

describe("rescaleCompFps", () => {
  it("秒タイミング維持で KF/inPoint/outPoint/duration を再スケール", () => {
    const o = obj("a", null, 0);
    o.inPoint = 10;
    o.outPoint = 30;
    o.transform.position.keyframes = [
      { frame: 0, value: { x: 0, y: 0, z: 0 }, easing: lin },
      { frame: 15, value: { x: 1, y: 0, z: 0 }, easing: lin },
    ];
    o.components = [{ type: "solid", props: { size: { value: 100, keyframes: [{ frame: 30, value: 200, easing: lin }] } } }];
    const out = rescaleCompFps(comp([o]), 60); // ratio 2
    expect(out.fps).toBe(60);
    expect(out.duration).toBe(120);
    const ro = out.objects[0]!;
    expect(ro.inPoint).toBe(20);
    expect(ro.outPoint).toBe(60);
    expect(ro.transform.position.keyframes.map((k) => k.frame)).toEqual([0, 30]);
    const sizeProp = ro.components[0]!.props["size"] as AnimatedProp<number>;
    expect(sizeProp.keyframes[0]!.frame).toBe(60);
  });

  it("fps 同値は KF 不変で fps のみ反映", () => {
    const o = obj("a", null, 0);
    o.transform.position.keyframes = [{ frame: 7, value: { x: 0, y: 0, z: 0 }, easing: lin }];
    const out = rescaleCompFps(comp([o]), 30);
    expect(out.fps).toBe(30);
    expect(out.objects[0]!.transform.position.keyframes[0]!.frame).toBe(7);
  });

  it("fps<=0 は無視", () => {
    const c = comp([obj("a", null, 0)]);
    expect(rescaleCompFps(c, 0)).toBe(c);
  });
});
