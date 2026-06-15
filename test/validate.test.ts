import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp } from "../src/core/props";
import { ProjectError, validateProject } from "../src/core/validate";
import type { Project, SceneObject, TimelineComposition } from "../src/core/schema";

function obj(id: string, parent: string | null): SceneObject {
  return {
    id,
    name: id,
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

function withObjects(objects: SceneObject[]): Project {
  const p = createProject({ now: "2026-01-01T00:00:00.000Z" });
  (p.compositions[0] as TimelineComposition).objects = objects;
  return p;
}

describe("validateProject", () => {
  it("treats unknown parent as root and warns", () => {
    const { project, warnings } = validateProject(
      withObjects([obj("A", "MISSING")]),
    );
    const comp = project.compositions[0] as TimelineComposition;
    expect(comp.objects[0]?.parent).toBeNull();
    expect(warnings.some((w) => w.includes("unknown parent"))).toBe(true);
  });

  it("accepts valid parent chains", () => {
    const { warnings } = validateProject(
      withObjects([obj("A", null), obj("B", "A"), obj("C", "B")]),
    );
    expect(warnings).toEqual([]);
  });

  it("rejects parent cycles", () => {
    expect(() =>
      validateProject(withObjects([obj("A", "B"), obj("B", "A")])),
    ).toThrow(ProjectError);
  });

  it("refuses to load a newer schemaVersion", () => {
    const p = createProject({ now: "2026-01-01T00:00:00.000Z" });
    (p as { schemaVersion: number }).schemaVersion = 99;
    expect(() => validateProject(p)).toThrow(ProjectError);
  });

  it("rejects non-object root", () => {
    expect(() => validateProject(null)).toThrow(ProjectError);
    expect(() => validateProject("nope")).toThrow(ProjectError);
  });
});
