import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp } from "../src/core/props";
import { serializeProject } from "../src/core/serialize";
import { validateProject } from "../src/core/validate";
import { resolve } from "../src/runtime/resolve";
import { blendModeToCompositeOp, isCssBlendMode } from "../src/runtime/blendCompose";
import { isKnownBlendMode, normalizeBlendMode } from "../src/core/blendMode";
import { BLEND_MODES } from "../src/core/schema";
import type { BlendMode, Project, SceneObject, TimelineComposition } from "../src/core/schema";

function timeline(p: Project): TimelineComposition {
  const comp = p.compositions[0];
  if (!comp || comp.kind !== "timeline") throw new Error("expected timeline");
  return comp;
}

function obj(id: string, blendMode?: BlendMode): SceneObject {
  return {
    id,
    name: `o-${id}`,
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 30,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [],
    blendMode,
  };
}

// §5.4d / §5.6-canon / INV-4: blendMode は "normal" 以外のときだけ書き、
// "normal"・undefined では省略する（既存 project.json と byte 等価）。
describe("blendMode canonical serialization", () => {
  const now = "2026-01-01T00:00:00.000Z";

  it("非 normal は blendMode を書く", () => {
    const p = structuredClone(createProject({ now }));
    timeline(p).objects = [obj("01MULT0000000000000000000A", "multiply")];
    expect(serializeProject(p)).toContain('"blendMode": "multiply"');
  });

  it("normal / undefined は省略し byte 等価", () => {
    const base = structuredClone(createProject({ now }));
    const normal = structuredClone(base);
    timeline(normal).objects = [obj("01OBJ000000000000000000001", "normal")];
    const none = structuredClone(base);
    timeline(none).objects = [obj("01OBJ000000000000000000001", undefined)];
    expect(serializeProject(normal)).toBe(serializeProject(none));
    expect(serializeProject(normal)).not.toContain("blendMode");
  });
});

describe("blendMode helpers", () => {
  it("isKnownBlendMode は BLEND_MODES と一致", () => {
    for (const m of BLEND_MODES) expect(isKnownBlendMode(m)).toBe(true);
    expect(isKnownBlendMode("ditherDissolve")).toBe(false);
    expect(isKnownBlendMode("bogus")).toBe(false);
  });

  it("normalizeBlendMode は未知を normal に収束", () => {
    expect(normalizeBlendMode(undefined)).toBe("normal");
    expect(normalizeBlendMode("")).toBe("normal");
    expect(normalizeBlendMode("ditherDissolve")).toBe("normal");
    expect(normalizeBlendMode("multiply")).toBe("multiply");
  });
});

// §5.4d: 不明な blendMode は normal 扱い（undefined）+ missingBlendModes 記録。
describe("blendMode validation", () => {
  const now = "2026-01-01T00:00:00.000Z";

  it("不明な値は strip + warn + missingBlendModes", () => {
    const p = structuredClone(createProject({ now }));
    const o = obj("01OBJ000000000000000000001");
    (o as { blendMode?: string }).blendMode = "bogus";
    timeline(p).objects = [o];
    const { project, warnings, missingBlendModes } = validateProject(p);
    expect(timeline(project).objects[0]!.blendMode).toBeUndefined();
    expect(warnings.some((w) => w.includes("blendMode"))).toBe(true);
    expect(missingBlendModes["01OBJ000000000000000000001"]).toBe("bogus");
  });

  it("ditherDissolve は unknown 扱い", () => {
    const p = structuredClone(createProject({ now }));
    const o = obj("01OBJ000000000000000000001");
    (o as { blendMode?: string }).blendMode = "ditherDissolve";
    timeline(p).objects = [o];
    const { project, missingBlendModes } = validateProject(p);
    expect(timeline(project).objects[0]!.blendMode).toBeUndefined();
    expect(missingBlendModes["01OBJ000000000000000000001"]).toBe("ditherDissolve");
  });

  it("空文字は missing 記録せず strip", () => {
    const p = structuredClone(createProject({ now }));
    const o = obj("01OBJ000000000000000000001");
    (o as { blendMode?: string }).blendMode = "";
    timeline(p).objects = [o];
    const { project, missingBlendModes } = validateProject(p);
    expect(timeline(project).objects[0]!.blendMode).toBeUndefined();
    expect(missingBlendModes["01OBJ000000000000000000001"]).toBeUndefined();
  });
});

// §5.4d / INV-3: resolve は blendMode を補間せず素通しする（既定 normal）。
describe("blendMode resolve passthrough", () => {
  function comp(objects: SceneObject[]): TimelineComposition {
    return { id: "C", name: "Main", kind: "timeline", width: 100, height: 100, fps: 30, duration: 30, objects };
  }

  it("既定は normal", () => {
    const scene = resolve(comp([obj("a")]), 0);
    expect(scene.objects[0]!.blendMode).toBe("normal");
  });

  it("設定値を素通し", () => {
    const scene = resolve(comp([obj("a", "screen")]), 0);
    expect(scene.objects[0]!.blendMode).toBe("screen");
  });

  it("未知値は normal に正規化", () => {
    const o = obj("a");
    (o as { blendMode?: string }).blendMode = "ditherDissolve";
    const scene = resolve(comp([o]), 0);
    expect(scene.objects[0]!.blendMode).toBe("normal");
  });
});

// §5.4d: capture コンポジットの blendMode → globalCompositeOperation 写像。
describe("blendMode composite mapping", () => {
  it("normal は source-over、他は同名", () => {
    expect(blendModeToCompositeOp("normal")).toBe("source-over");
    expect(blendModeToCompositeOp("multiply")).toBe("multiply");
    expect(blendModeToCompositeOp("color-dodge")).toBe("color-dodge");
  });

  it("isCssBlendMode は normal を除く 15 種のみ true", () => {
    const cssTrue = BLEND_MODES.filter((m) => isCssBlendMode(m));
    expect(cssTrue.length).toBe(15);
    expect(isCssBlendMode("normal")).toBe(false);
  });
});
