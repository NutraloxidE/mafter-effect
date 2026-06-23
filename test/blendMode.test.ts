import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp } from "../src/core/props";
import { serializeProject } from "../src/core/serialize";
import { validateProject } from "../src/core/validate";
import { resolve } from "../src/runtime/resolve";
import { bayerMatrix, ditherVisible } from "../src/runtime/ditherMask";
import { blendModeToCompositeOp, isCssBlendMode } from "../src/runtime/blendCompose";
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

// §5.4d: 不明な blendMode は normal 扱い（undefined）にする。
describe("blendMode validation", () => {
  const now = "2026-01-01T00:00:00.000Z";

  it("不明な値は strip + warn", () => {
    const p = structuredClone(createProject({ now }));
    const o = obj("01OBJ000000000000000000001");
    (o as { blendMode?: string }).blendMode = "bogus";
    timeline(p).objects = [o];
    const { project, warnings } = validateProject(p);
    expect(timeline(project).objects[0]!.blendMode).toBeUndefined();
    expect(warnings.some((w) => w.includes("blendMode"))).toBe(true);
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
});

// §5.4d: capture コンポジットの blendMode → globalCompositeOperation 写像。
describe("blendMode composite mapping", () => {
  it("normal / ditherDissolve は source-over、他は同名", () => {
    expect(blendModeToCompositeOp("normal")).toBe("source-over");
    expect(blendModeToCompositeOp("ditherDissolve")).toBe("source-over");
    expect(blendModeToCompositeOp("multiply")).toBe("multiply");
    expect(blendModeToCompositeOp("color-dodge")).toBe("color-dodge");
  });

  it("isCssBlendMode は normal/ditherDissolve を除く 15 種のみ true", () => {
    const cssTrue = BLEND_MODES.filter((m) => isCssBlendMode(m));
    expect(cssTrue.length).toBe(15);
    expect(isCssBlendMode("normal")).toBe(false);
    expect(isCssBlendMode("ditherDissolve")).toBe(false);
  });
});

// §5.4d / INV-1: Bayer 秩序ディザは完全決定論（Math.random 不要）。
describe("ditherMask determinism", () => {
  it("8×8 Bayer は 0..63 の全階調を 1 度ずつ含む", () => {
    const m = bayerMatrix(8);
    const flat = m.flat().sort((a, b) => a - b);
    expect(flat).toEqual(Array.from({ length: 64 }, (_, i) => i));
  });

  it("opacity が上がると可視テクセル数は単調増加", () => {
    const count = (op: number) => {
      let n = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (ditherVisible(x, y, op)) n++;
      return n;
    };
    expect(count(0)).toBe(0);
    expect(count(1)).toBe(64);
    expect(count(0.25)).toBeLessThan(count(0.75));
  });

  it("同 opacity は同一結果（決定論）", () => {
    expect(ditherVisible(3, 5, 0.5)).toBe(ditherVisible(3, 5, 0.5));
  });
});
