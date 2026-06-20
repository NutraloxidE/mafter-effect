import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp } from "../src/core/props";
import { serializeProject } from "../src/core/serialize";
import type { Project, SceneObject, TimelineComposition } from "../src/core/schema";

function timeline(p: Project): TimelineComposition {
  const comp = p.compositions[0];
  if (!comp || comp.kind !== "timeline") throw new Error("expected timeline");
  return comp;
}

function adj(id: string, mode?: "live" | "raster"): SceneObject {
  return {
    id,
    name: `adj-${id}`,
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 30,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [],
    isAdjustment: true,
    adjustmentMode: mode,
  };
}

// §27.4 / §5.6-canon / INV-4: adjustmentMode は raster のときだけ書き、live・undefined・
// 非調整レイヤーでは省略する（既存 project.json と byte 等価を保つ）。
describe("adjustmentMode canonical serialization", () => {
  const now = "2026-01-01T00:00:00.000Z";

  it("raster 調整レイヤーは adjustmentMode を書く", () => {
    const p = structuredClone(createProject({ now }));
    timeline(p).objects = [adj("01RASTER0000000000000000AA", "raster")];
    expect(serializeProject(p)).toContain('"adjustmentMode": "raster"');
  });

  it("live / undefined は省略し、フィールド無しと byte 等価", () => {
    const base = structuredClone(createProject({ now }));
    const live = structuredClone(base);
    timeline(live).objects = [adj("01OBJ000000000000000000001", "live")];
    const none = structuredClone(base);
    timeline(none).objects = [adj("01OBJ000000000000000000001", undefined)];
    expect(serializeProject(live)).toBe(serializeProject(none));
    expect(serializeProject(live)).not.toContain("adjustmentMode");
  });

  it("非調整レイヤーに raster が紛れても省略する", () => {
    const p = structuredClone(createProject({ now }));
    const o = adj("01OBJ000000000000000000001", "raster");
    o.isAdjustment = undefined; // 調整レイヤーではない
    timeline(p).objects = [o];
    expect(serializeProject(p)).not.toContain("adjustmentMode");
  });
});
