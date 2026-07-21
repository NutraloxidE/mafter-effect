import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "../src/editor/store";
import { currentTimelineComp } from "../src/editor/store";

function objById(id: string) {
  const s = useEditorStore.getState();
  return currentTimelineComp(s.project, s.currentCompId)!.objects.find((o) => o.id === id)!;
}

describe("multi-select toggle sync", () => {
  beforeEach(() => {
    useEditorStore.getState().newProject();
  });

  it("setBlendMode applies to whole selection when multiple are selected", () => {
    const s = useEditorStore.getState();
    const a = s.addSolid("A")!;
    const b = s.addSolid("B")!;
    useEditorStore.getState().selectObjects([a, b]);

    useEditorStore.getState().setBlendMode(a, "multiply");

    expect(objById(a).blendMode).toBe("multiply");
    expect(objById(b).blendMode).toBe("multiply");
  });

  it("setThreeD applies to whole selection, single command (one undo)", () => {
    const s = useEditorStore.getState();
    const a = s.addSolid("A")!;
    const b = s.addSolid("B")!;
    useEditorStore.getState().selectObjects([a, b]);

    useEditorStore.getState().setThreeD(a, true);
    expect(objById(a).threeD).toBe(true);
    expect(objById(b).threeD).toBe(true);

    useEditorStore.getState().undo();
    expect(objById(a).threeD).toBeUndefined();
    expect(objById(b).threeD).toBeUndefined();
  });

  it("does not touch non-selected layers", () => {
    const s = useEditorStore.getState();
    const a = s.addSolid("A")!;
    const b = s.addSolid("B")!;
    const c = s.addSolid("C")!;
    useEditorStore.getState().selectObjects([a, b]);

    useEditorStore.getState().setBlendMode(a, "screen");
    expect(objById(c).blendMode).toBeUndefined();
  });
});
