import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp } from "../src/core/props";
import type { SceneObject } from "../src/core/schema";
import { cmdAddObject } from "../src/editor/commands";
import type { EditorStore } from "../src/editor/store";

describe("cmdAddObject labelIndex", () => {
  it("assigns type default labelIndex when omitted", () => {
    const project = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const compId = project.rootComposition;
    const commands: { label: string; before: typeof project; after: typeof project }[] = [];
    const store = {
      project,
      currentCompId: compId,
      applyCommand: (cmd: { label: string; before: typeof project; after: typeof project }) => {
        commands.push(cmd);
      },
    } as unknown as EditorStore;

    const obj: SceneObject = {
      id: "01NEWOBJ",
      name: "Solid",
      parent: null,
      zOrder: 1,
      enabled: true,
      inPoint: 0,
      outPoint: 150,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [{ type: "solid", props: {} }],
    };
    cmdAddObject(store, obj);

    expect(commands).toHaveLength(1);
    const comp = commands[0]!.after.compositions.find((c) => c.id === compId);
    expect(comp?.kind).toBe("timeline");
    if (comp?.kind === "timeline") {
      const added = comp.objects.find((o) => o.id === "01NEWOBJ");
      expect(added?.labelIndex).toBe(0);
    }
  });

  it("preserves explicit labelIndex", () => {
    const project = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const compId = project.rootComposition;
    let afterProject = project;
    const store = {
      project,
      currentCompId: compId,
      applyCommand: (cmd: { after: typeof project }) => { afterProject = cmd.after; },
    } as unknown as EditorStore;

    const obj: SceneObject = {
      id: "01NEWOBJ2",
      name: "Text",
      parent: null,
      zOrder: 1,
      enabled: true,
      inPoint: 0,
      outPoint: 150,
      transform: defaultTransform(),
      opacity: staticProp(1),
      labelIndex: 3,
      components: [{ type: "text", props: {} }],
    };
    cmdAddObject(store, obj);

    const comp = afterProject.compositions.find((c) => c.id === compId);
    if (comp?.kind === "timeline") {
      expect(comp.objects.find((o) => o.id === "01NEWOBJ2")?.labelIndex).toBe(3);
    }
  });
});
