import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp } from "../src/core/props";
import {
  canonicalStringify,
  canonicalizeProject,
  serializeProject,
} from "../src/core/serialize";
import type { Project, SceneObject, TimelineComposition } from "../src/core/schema";

function timeline(p: Project): TimelineComposition {
  const comp = p.compositions[0];
  if (!comp || comp.kind !== "timeline") throw new Error("expected timeline");
  return comp;
}

function obj(id: string, parent: string | null = null): SceneObject {
  return {
    id,
    name: `obj-${id}`,
    parent,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 30,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [],
  };
}

describe("canonicalStringify", () => {
  it("sorts object keys alphabetically and appends trailing newline", () => {
    const out = canonicalStringify({ b: 1, a: 2 });
    expect(out).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
  });

  it("is idempotent regardless of input key order", () => {
    const a = canonicalStringify({ x: 1, y: { p: 2, q: 3 } });
    const b = canonicalStringify({ y: { q: 3, p: 2 }, x: 1 });
    expect(a).toBe(b);
  });

  it("omits undefined properties and rejects non-finite numbers", () => {
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{\n  "b": 1\n}\n');
    expect(() => canonicalStringify({ a: NaN })).toThrow();
  });
});

describe("serializeProject", () => {
  it("sorts objects by id independent of array order", () => {
    const base = createProject({ now: "2026-01-01T00:00:00.000Z" });

    const p1: Project = structuredClone(base);
    const p2: Project = structuredClone(base);
    timeline(p1).objects = [obj("01B"), obj("01A")];
    timeline(p2).objects = [obj("01A"), obj("01B")];

    expect(serializeProject(p1)).toBe(serializeProject(p2));
  });

  it("produces a trailing newline", () => {
    const text = serializeProject(
      createProject({ now: "2026-01-01T00:00:00.000Z" }),
    );
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("omits bpm/beatsPerBar when bpm is unset or 0 (byte-equal to baseline)", () => {
    const base = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const baseline = serializeProject(base);

    const withZero: Project = structuredClone(base);
    timeline(withZero).bpm = 0;
    timeline(withZero).beatsPerBar = 4;
    expect(serializeProject(withZero)).toBe(baseline);
    expect(serializeProject(withZero)).not.toContain("bpm");
  });

  it("writes bpm but omits default beatsPerBar (4)", () => {
    const base = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const p: Project = structuredClone(base);
    timeline(p).bpm = 120;
    timeline(p).beatsPerBar = 4;
    const out = serializeProject(p);
    expect(out).toContain('"bpm": 120');
    expect(out).not.toContain("beatsPerBar");
  });

  it("writes non-default beatsPerBar when bpm > 0", () => {
    const base = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const p: Project = structuredClone(base);
    timeline(p).bpm = 90;
    timeline(p).beatsPerBar = 3;
    const out = serializeProject(p);
    expect(out).toContain('"bpm": 90');
    expect(out).toContain('"beatsPerBar": 3');
  });

  it("serializes labelIndex when in range and strips invalid values", () => {
    const base = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const p: Project = structuredClone(base);
    const o = obj("01A");
    o.labelIndex = 3;
    timeline(p).objects = [o];
    expect(serializeProject(p)).toContain('"labelIndex": 3');

    const bad: Project = structuredClone(p);
    timeline(bad).objects[0] = { ...o, labelIndex: 99 as SceneObject["labelIndex"] };
    const canon = canonicalizeProject(bad);
    const tcomp = canon.compositions[0];
    expect(tcomp?.kind).toBe("timeline");
    if (tcomp?.kind === "timeline") {
      expect(tcomp.objects[0]?.labelIndex).toBeUndefined();
    }
    expect(serializeProject(canon)).not.toContain("labelIndex");
  });

  it("serializes locked when true and strips false", () => {
    const base = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const p: Project = structuredClone(base);
    const o = obj("01A");
    o.locked = true;
    timeline(p).objects = [o];
    expect(serializeProject(p)).toContain('"locked": true');

    const off: Project = structuredClone(p);
    timeline(off).objects[0] = { ...o, locked: false };
    const canon = canonicalizeProject(off);
    const tcomp = canon.compositions[0];
    expect(tcomp?.kind).toBe("timeline");
    if (tcomp?.kind === "timeline") {
      expect(tcomp.objects[0]?.locked).toBeUndefined();
    }
    expect(serializeProject(canon)).not.toContain("locked");
  });

  it("serializes blendMode when known and strips unknown values", () => {
    const base = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const p: Project = structuredClone(base);
    const o = obj("01A");
    o.blendMode = "multiply";
    timeline(p).objects = [o];
    expect(serializeProject(p)).toContain('"blendMode": "multiply"');

    const bad: Project = structuredClone(p);
    const badObj = { ...o };
    (badObj as { blendMode?: string }).blendMode = "ditherDissolve";
    timeline(bad).objects[0] = badObj;
    const canon = canonicalizeProject(bad);
    const tcomp = canon.compositions[0];
    expect(tcomp?.kind).toBe("timeline");
    if (tcomp?.kind === "timeline") {
      expect(tcomp.objects[0]?.blendMode).toBeUndefined();
    }
    expect(serializeProject(canon)).not.toContain("blendMode");
  });
});
