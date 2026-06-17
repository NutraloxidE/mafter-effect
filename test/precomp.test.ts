import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import { createProject } from "../src/core/createProject";
import { newCompId, newObjectId } from "../src/core/ids";
import { defaultTransform, staticProp } from "../src/core/props";
import type { Project, SceneObject, TimelineComposition } from "../src/core/schema";
import { useEditorStore } from "../src/editor/store";
import {
  MAX_COMP_NEST_DEPTH,
  compChildFrame,
  compWouldCreateCycle,
  isCompNestDepthAllowed,
} from "../src/runtime/compLayer";
import { resolve } from "../src/runtime/resolve";

function timelineComp(id: string, objects: SceneObject[] = [], duration = 100): TimelineComposition {
  return {
    id,
    name: id,
    kind: "timeline",
    width: 1920,
    height: 1080,
    fps: 30,
    duration,
    objects,
  };
}

function compLayerObject(id: string, compId: string, inPoint = 0): SceneObject {
  return {
    id,
    name: id,
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint,
    outPoint: 100,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [{ type: "comp", props: { compId, trimStart: 0 } }],
  };
}

describe("compLayer — childFrame mapping (§23.2 Freeze)", () => {
  it("maps 1:1 from parent frame when inPoint and trimStart are 0", () => {
    expect(compChildFrame(10, 0, 0, 100)).toBe(10);
  });

  it("freezes at frame 0 when parent is before layer inPoint", () => {
    expect(compChildFrame(5, 10, 0, 100)).toBe(0);
  });

  it("freezes at last frame when parent exceeds child duration", () => {
    expect(compChildFrame(150, 0, 0, 100)).toBe(99);
  });

  it("applies trimStart offset", () => {
    expect(compChildFrame(20, 0, 5, 100)).toBe(25);
  });

  it("combines inPoint and trimStart", () => {
    expect(compChildFrame(30, 10, 5, 100)).toBe(25);
  });
});

describe("compLayer — nest depth guard (§23.3)", () => {
  it("allows depth 1 through MAX_COMP_NEST_DEPTH", () => {
    for (let d = 1; d <= MAX_COMP_NEST_DEPTH; d++) {
      expect(isCompNestDepthAllowed(d)).toBe(true);
    }
  });

  it("blocks depth beyond MAX_COMP_NEST_DEPTH", () => {
    expect(isCompNestDepthAllowed(MAX_COMP_NEST_DEPTH + 1)).toBe(false);
  });
});

describe("compLayer — cycle detection (§23.4)", () => {
  it("detects direct cycle A → B → A", () => {
    const a = "A";
    const b = "B";
    const p: Project = {
      ...createProject({ now: "2026-01-01T00:00:00.000Z" }),
      compositions: [
        timelineComp(a, [compLayerObject("o1", b)]),
        timelineComp(b),
      ],
    };
    expect(compWouldCreateCycle(p, b, a)).toBe(true);
  });

  it("detects indirect cycle A → B → C → A", () => {
    const a = "A";
    const b = "B";
    const c = "C";
    const p: Project = {
      ...createProject({ now: "2026-01-01T00:00:00.000Z" }),
      compositions: [
        timelineComp(a, [compLayerObject("o1", b)]),
        timelineComp(b, [compLayerObject("o2", c)]),
        timelineComp(c),
      ],
    };
    expect(compWouldCreateCycle(p, c, a)).toBe(true);
  });

  it("returns false for acyclic nesting", () => {
    const a = "A";
    const b = "B";
    const c = "C";
    const p: Project = {
      ...createProject({ now: "2026-01-01T00:00:00.000Z" }),
      compositions: [
        timelineComp(a, [compLayerObject("o1", b)]),
        timelineComp(b),
        timelineComp(c),
      ],
    };
    expect(compWouldCreateCycle(p, a, c)).toBe(false);
  });
});

describe("resolve — comp _inPoint injection (§23.2)", () => {
  it("injects layer inPoint into resolved comp props as _inPoint", () => {
    const childId = newCompId();
    const obj = compLayerObject(newObjectId(), childId, 12);
    const comp = timelineComp(newCompId(), [obj]);
    const scene = resolve(comp, 12);
    const rc = scene.objects[0]!.components[0]!;
    expect(rc.type).toBe("comp");
    expect(rc.props["_inPoint"]).toBe(12);
    expect(rc.props.compId).toBe(childId);
  });
});

describe("store.addCompLayer — cycle & self-ref rejection (§23.4)", () => {
  beforeEach(() => {
    useEditorStore.getState().newProject();
  });

  it("rejects self-reference", () => {
    const rootId = useEditorStore.getState().currentCompId;
    expect(useEditorStore.getState().addCompLayer(rootId)).toBeNull();
  });

  it("allows acyclic comp layer", () => {
    const rootId = useEditorStore.getState().currentCompId;
    const childId = useEditorStore.getState().addTimelineComp("Child");
    expect(childId).toBeTruthy();
    useEditorStore.getState().setCurrentComp(rootId);
    expect(useEditorStore.getState().addCompLayer(childId!)).toBeTruthy();
  });

  it("rejects cycle when child would reference parent", () => {
    const rootId = useEditorStore.getState().currentCompId;
    const childId = useEditorStore.getState().addTimelineComp("Child")!;
    useEditorStore.getState().setCurrentComp(rootId);
    useEditorStore.getState().addCompLayer(childId);
    useEditorStore.getState().setCurrentComp(childId);
    expect(useEditorStore.getState().addCompLayer(rootId)).toBeNull();
  });
});
