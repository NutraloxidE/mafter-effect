import { describe, expect, it } from "vitest";
import { buildSelectionCollectionPatches } from "../src/editor/multiSelectPropEdit";
import { staticProp } from "../src/core/props";
import type { SceneObject } from "../src/core/schema";

function obj(id: string, compProps: Record<string, unknown>, type = "text"): SceneObject {
  return { id, components: [{ type, props: compProps }] } as unknown as SceneObject;
}

describe("buildSelectionCollectionPatches", () => {
  it("applies a numeric change as delta, preserving each target's own value", () => {
    const base = obj("a", { fontSize: staticProp(40) });
    const target = obj("b", { fontSize: staticProp(20) });
    // base edited 40 -> 48 (delta +8)
    const patch = { components: [{ type: "text", props: { fontSize: staticProp(48) } }] } as Partial<SceneObject>;

    const patches = buildSelectionCollectionPatches(base, patch, "components", [base, target], 0);
    const bPatch = patches.find((p) => p.id === "b")!.patch.components![0].props as Record<string, unknown>;
    expect((bPatch.fontSize as { value: number }).value).toBe(28); // 20 + 8
    // base keeps the literal patch
    expect(patches.find((p) => p.id === "a")!.patch).toBe(patch);
  });

  it("applies non-numeric (enum) changes as same value", () => {
    const base = obj("a", { bevelStyle: "angular" });
    const target = obj("b", { bevelStyle: "concave" });
    const patch = { components: [{ type: "text", props: { bevelStyle: "round" } }] } as Partial<SceneObject>;

    const patches = buildSelectionCollectionPatches(base, patch, "components", [base, target], 0);
    const bPatch = patches.find((p) => p.id === "b")!.patch.components![0].props as Record<string, unknown>;
    expect(bPatch.bevelStyle).toBe("round");
  });

  it("skips targets lacking a matching component type", () => {
    const base = obj("a", { fontSize: staticProp(40) }, "text");
    const solid = obj("b", { fillColor: "#fff" }, "solid");
    const patch = { components: [{ type: "text", props: { fontSize: staticProp(48) } }] } as Partial<SceneObject>;

    const patches = buildSelectionCollectionPatches(base, patch, "components", [base, solid], 0);
    expect(patches.map((p) => p.id)).toEqual(["a"]);
  });
});
