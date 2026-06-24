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
  compLayerDefaultOutPoint,
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

describe("compLayer — childFrame mapping (§23.2 Freeze, equal fps)", () => {
  it("maps 1:1 from parent frame when inPoint and trimStart are 0", () => {
    expect(compChildFrame(10, 0, 0, 100, 30, 30)).toBe(10);
  });

  it("freezes at frame 0 when parent is before layer inPoint", () => {
    expect(compChildFrame(5, 10, 0, 100, 30, 30)).toBe(0);
  });

  it("freezes at last frame when parent exceeds child duration", () => {
    expect(compChildFrame(150, 0, 0, 100, 30, 30)).toBe(99);
  });

  it("applies trimStart offset", () => {
    expect(compChildFrame(20, 0, 5, 100, 30, 30)).toBe(25);
  });

  it("combines inPoint and trimStart", () => {
    expect(compChildFrame(30, 10, 5, 100, 30, 30)).toBe(25);
  });
});

describe("compLayer — childFrame mapping (§23.2 fps-aware 2026-06-24)", () => {
  it("equal fps は旧式 (parentFrame - inPoint + trimStart) と完全一致", () => {
    for (const fps of [24, 30, 60]) {
      for (const pf of [0, 7, 50, 99]) {
        const inPoint = 3, trimStart = 4, dur = 200;
        const oldFormula = Math.max(0, Math.min(pf - inPoint + trimStart, dur - 1));
        expect(compChildFrame(pf, inPoint, trimStart, dur, fps, fps)).toBe(oldFormula);
      }
    }
  });

  it("親60fps / 子30fps は子を半速サンプル（実時間維持）", () => {
    // parentTimeSec = 60/60 = 1s → childFrame = round(1*30) = 30
    expect(compChildFrame(60, 0, 0, 200, 60, 30)).toBe(30);
    // parentTimeSec = 30/60 = 0.5s → round(0.5*30)=15
    expect(compChildFrame(30, 0, 0, 200, 60, 30)).toBe(15);
  });

  it("親30fps / 子60fps は子を倍速サンプル（実時間維持）", () => {
    // parentTimeSec = 30/30 = 1s → round(1*60)=60
    expect(compChildFrame(30, 0, 0, 200, 30, 60)).toBe(60);
  });

  it("fps 不一致でも trimStart は子 frame 単位で加算", () => {
    // parentTimeSec=1s, childFps=30 → 30 + trimStart 5 = 35
    expect(compChildFrame(60, 0, 5, 200, 60, 30)).toBe(35);
  });
});

describe("compLayer — default outPoint (§23.2 initial placement)", () => {
  it("同 fps: 子 duration をそのまま親 frame 尺にする", () => {
    expect(compLayerDefaultOutPoint(0, 0, 150, 30, 30, 450)).toBe(150);
  });

  it("fps 不一致: 秒ベースで親 frame に換算", () => {
    expect(compLayerDefaultOutPoint(0, 0, 150, 60, 30, 900)).toBe(300);
  });

  it("子が親より長い場合は parentDuration で clamp", () => {
    expect(compLayerDefaultOutPoint(0, 0, 450, 30, 30, 150)).toBe(150);
  });

  it("outPoint は inPoint+1 以上", () => {
    expect(compLayerDefaultOutPoint(10, 0, 1, 30, 30, 100)).toBe(11);
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

  it("injects parent comp fps as _parentFps (§23.2 fps-aware mapping・stale currentComp 非依存)", () => {
    const childId = newCompId();
    const obj = compLayerObject(newObjectId(), childId, 0);
    const comp: TimelineComposition = { ...timelineComp(newCompId(), [obj]), fps: 60 };
    const scene = resolve(comp, 0);
    const rc = scene.objects[0]!.components[0]!;
    expect(rc.props["_parentFps"]).toBe(60);
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

  it("sets outPoint to child comp duration (not parent full duration)", () => {
    const parentId = useEditorStore.getState().currentCompId;
    useEditorStore.getState().setCompDuration(450);
    const childId = useEditorStore.getState().addTimelineComp("Child5s")!;
    useEditorStore.getState().setCurrentComp(parentId);
    const layerId = useEditorStore.getState().addCompLayer(childId)!;
    expect(layerId).toBeTruthy();
    const after = useEditorStore.getState();
    const parent = after.project!.compositions.find((c) => c.id === parentId && c.kind === "timeline") as TimelineComposition;
    const layer = parent.objects.find((o) => o.id === layerId)!;
    expect(layer.outPoint).toBe(150);
    expect(parent.duration).toBe(450);
  });
});
