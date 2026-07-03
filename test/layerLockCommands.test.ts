import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp } from "../src/core/props";
import type { SceneObject } from "../src/core/schema";
import { cmdRemoveObjects, cmdUpdateObject } from "../src/editor/commands";
import type { EditorStore } from "../src/editor/store";

function makeLockedObject(id: string): SceneObject {
  return {
    id,
    name: id,
    parent: null,
    zOrder: 1,
    enabled: true,
    locked: true,
    inPoint: 0,
    outPoint: 150,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [{ type: "solid", props: {} }],
  };
}

describe("layer lock commands", () => {
  it("cmdUpdateObject rejects transform patch on locked layer", () => {
    const project = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const compId = project.rootComposition;
    const comp = project.compositions.find((c) => c.id === compId);
    if (comp?.kind !== "timeline") throw new Error("expected timeline comp");
    const obj = makeLockedObject("01LOCKED1");
    comp.objects = [obj];

    const commands: unknown[] = [];
    const store = {
      project,
      currentCompId: compId,
      applyCommand: (cmd: unknown) => { commands.push(cmd); },
    } as unknown as EditorStore;

    cmdUpdateObject(store, obj.id, { name: "Nope" }, "Rename");
    expect(commands).toHaveLength(0);

    cmdUpdateObject(store, obj.id, { enabled: false }, "Toggle visibility");
    expect(commands).toHaveLength(1);

    cmdUpdateObject(store, obj.id, { locked: undefined }, "Unlock");
    expect(commands).toHaveLength(2);
  });

  it("cmdRemoveObjects skips locked layers", () => {
    const project = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const compId = project.rootComposition;
    const comp = project.compositions.find((c) => c.id === compId);
    if (comp?.kind !== "timeline") throw new Error("expected timeline comp");
    const locked = makeLockedObject("01LOCKED2");
    const unlocked: SceneObject = { ...makeLockedObject("01OPEN1"), locked: undefined };
    comp.objects = [locked, unlocked];

    const commands: { label: string }[] = [];
    const store = {
      project,
      currentCompId: compId,
      applyCommand: (cmd: { label: string }) => { commands.push(cmd); },
    } as unknown as EditorStore;

    cmdRemoveObjects(store, [locked.id, unlocked.id]);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.label).toBe("Remove 1 object(s)");
  });
});
