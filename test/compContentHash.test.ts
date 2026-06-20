import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp } from "../src/core/props";
import type { Project, SceneObject, TimelineComposition } from "../src/core/schema";
import { compContentHash } from "../src/cache/compContentHash";

function timelineComp(id: string, objects: SceneObject[] = [], duration = 100): TimelineComposition {
  return { id, name: id, kind: "timeline", width: 1920, height: 1080, fps: 30, duration, objects };
}

function solidObject(id: string, color = { r: 1, g: 0, b: 0, a: 1 }): SceneObject {
  return {
    id,
    name: id,
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 100,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [{ type: "solid", props: { color, size: { x: 100, y: 100 } } }],
  };
}

function compLayerObject(id: string, compId: string): SceneObject {
  return {
    id,
    name: id,
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 100,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [{ type: "comp", props: { compId, trimStart: 0 } }],
  };
}

function project(comps: TimelineComposition[]): Project {
  return {
    ...createProject({ now: "2026-01-01T00:00:00.000Z" }),
    compositions: comps,
  };
}

// §28.11 comp 内容ハッシュ（projectRevision 非依存・content 基準）。
describe("compContentHash — content 同一性（§28.11）", () => {
  it("同一内容なら同一ハッシュ（決定論）", () => {
    const p1 = project([timelineComp("A", [solidObject("o1")])]);
    const p2 = project([timelineComp("A", [solidObject("o1")])]);
    expect(compContentHash(p1, "A")).toBe(compContentHash(p2, "A"));
  });

  it("comp(A) を編集するとハッシュが変わる", () => {
    const p1 = project([timelineComp("A", [solidObject("o1", { r: 1, g: 0, b: 0, a: 1 })])]);
    const p2 = project([timelineComp("A", [solidObject("o1", { r: 0, g: 1, b: 0, a: 1 })])]);
    expect(compContentHash(p1, "A")).not.toBe(compContentHash(p2, "A"));
  });

  it("comp(B) のみを編集しても comp(A) のハッシュは不変（核心）", () => {
    const a = timelineComp("A", [solidObject("o1")]);
    const p1 = project([a, timelineComp("B", [compLayerObject("b1", "A")])]);
    // comp(B) にだけオブジェクトを追加。
    const p2 = project([
      a,
      timelineComp("B", [compLayerObject("b1", "A"), solidObject("b2")]),
    ]);
    expect(compContentHash(p2, "A")).toBe(compContentHash(p1, "A"));
  });

  it("ネスト comp(A) の変更は親 comp(B) のハッシュへ伝播する", () => {
    const p1 = project([
      timelineComp("A", [solidObject("o1", { r: 1, g: 0, b: 0, a: 1 })]),
      timelineComp("B", [compLayerObject("b1", "A")]),
    ]);
    const p2 = project([
      timelineComp("A", [solidObject("o1", { r: 0, g: 1, b: 0, a: 1 })]),
      timelineComp("B", [compLayerObject("b1", "A")]),
    ]);
    expect(compContentHash(p2, "B")).not.toBe(compContentHash(p1, "B"));
  });

  it("objects の配列順が違っても内容が同じならハッシュは一致（id 昇順正規化）", () => {
    const p1 = project([timelineComp("A", [solidObject("o1"), solidObject("o2")])]);
    const p2 = project([timelineComp("A", [solidObject("o2"), solidObject("o1")])]);
    expect(compContentHash(p1, "A")).toBe(compContentHash(p2, "A"));
  });
});
