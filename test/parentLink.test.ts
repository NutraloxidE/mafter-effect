import { describe, expect, it } from "vitest";
import { defaultTransform, staticProp } from "../src/core/props";
import type { SceneObject } from "../src/core/schema";
import {
  collectDescendantIds,
  isValidParent,
  listParentCandidates,
} from "../src/editor/parentLink";

function obj(id: string, parent: string | null = null): SceneObject {
  return {
    id,
    name: id,
    parent,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 100,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [],
  };
}

describe("parentLink", () => {
  it("rejects self as parent", () => {
    const objects = [obj("a")];
    expect(isValidParent(objects, "a", "a")).toBe(false);
  });

  it("rejects descendant as parent", () => {
    const objects = [obj("a"), obj("b", "a"), obj("c", "b")];
    expect(collectDescendantIds(objects, "a")).toEqual(new Set(["b", "c"]));
    expect(isValidParent(objects, "a", "b")).toBe(false);
    expect(isValidParent(objects, "a", "c")).toBe(false);
    expect(isValidParent(objects, "b", "c")).toBe(false);
  });

  it("allows null and non-descendant parents", () => {
    const objects = [obj("a"), obj("b", "a"), obj("c")];
    expect(isValidParent(objects, "b", null)).toBe(true);
    expect(isValidParent(objects, "b", "c")).toBe(true);
    expect(isValidParent(objects, "b", "a")).toBe(true);
  });

  it("listParentCandidates excludes self and descendants", () => {
    const objects = [obj("a"), obj("b", "a"), obj("c", "b"), obj("d")];
    const ids = listParentCandidates(objects, "a").map((o) => o.id);
    expect(ids).toEqual(["d"]);
  });
});
