import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp } from "../src/core/props";
import {
  canonicalStringify,
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
});
