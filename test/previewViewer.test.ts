import { describe, expect, it } from "vitest";
import { defaultTransform, staticProp, vec3 } from "../src/core/props";
import type { SceneObject, TimelineComposition } from "../src/core/schema";
import {
  anchorCompPosition,
  compToObjectLocal,
  compToScreen,
  compensatePositionForAnchor,
  computeFitPan,
  computeFitZoom,
  movedPosition,
  oppositeControlPoint,
  parentWorldMatrix,
  handleControlPoint,
  roundTripLocalToComp,
  roundTripTransformPoint,
  scaleFromOppositeCorner,
  screenToComp,
  zoomAtCursor,
} from "../src/editor/previewViewer";
import { identity, localMatrix, transformPoint } from "../src/runtime/mat4";

function makeObject(over: Partial<SceneObject> & { id: string }): SceneObject {
  return {
    name: over.id,
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 100,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [],
    ...over,
  };
}

function comp(objects: SceneObject[]): TimelineComposition {
  return {
    id: "C",
    name: "Main",
    kind: "timeline",
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 100,
    objects,
  };
}

describe("previewViewer — §25.1 view control", () => {
  it("computeFitZoom fits comp into viewport", () => {
    expect(computeFitZoom(960, 540, 1920, 1080)).toBeCloseTo(0.5, 6);
    expect(computeFitZoom(960, 540, 1920, 1080, true)).toBeCloseTo(0.5, 6);
    expect(computeFitZoom(4000, 3000, 1920, 1080, true)).toBe(1);
  });

  it("computeFitPan centers comp in viewport", () => {
    const pan = computeFitPan(960, 540, 1920, 1080, 0.5);
    expect(pan.x).toBeCloseTo(0, 6);
    expect(pan.y).toBeCloseTo(0, 6);
  });

  it("screenToComp ↔ compToScreen roundtrip", () => {
    const host = { left: 100, top: 50 };
    const zoom = 0.5;
    const pan = { x: 10, y: 20 };
    const compPt = { x: 400, y: 300, z: 0 };
    const screen = compToScreen(compPt.x, compPt.y, zoom, pan);
    const back = screenToComp(host.left + screen.x, host.top + screen.y, host, zoom, pan);
    expect(back.x).toBeCloseTo(compPt.x, 6);
    expect(back.y).toBeCloseTo(compPt.y, 6);
  });

  it("zoomAtCursor keeps cursor comp position fixed", () => {
    const zoom = 1;
    const pan = { x: 5, y: 10 };
    const cursor = { x: 200, y: 150, z: 0 };
    const next = zoomAtCursor(zoom, pan, cursor, 1.2);
    const screenBefore = (cursor.x + pan.x) * zoom;
    const screenAfter = (cursor.x + next.viewPan.x) * next.viewZoom;
    expect(screenAfter).toBeCloseTo(screenBefore, 6);
    const compAfter = screenAfter / next.viewZoom - next.viewPan.x;
    expect(compAfter).toBeCloseTo(cursor.x, 6);
  });
});

describe("previewViewer — §25.4 coordinate inverse", () => {
  it("roundTripLocalToComp via parent world", () => {
    const parentWorld = identity();
    const local = vec3(120, 80, 0);
    const back = roundTripLocalToComp(local, parentWorld);
    expect(back?.x).toBeCloseTo(local.x, 6);
    expect(back?.y).toBeCloseTo(local.y, 6);
  });

  it("roundTripTransformPoint preserves local content point", () => {
    const transform = {
      anchor: vec3(50, 50, 0),
      position: vec3(200, 150, 0),
      rotation: vec3(0, 0, 30),
      scale: vec3(1.5, 2, 1),
    };
    const localPt = vec3(10, 20, 0);
    const back = roundTripTransformPoint(localPt, identity(), transform);
    expect(back?.x).toBeCloseTo(localPt.x, 4);
    expect(back?.y).toBeCloseTo(localPt.y, 4);
  });

  it("compToObjectLocal roundtrips through world matrix", () => {
    const transform = {
      anchor: vec3(0, 0, 0),
      position: vec3(100, 50, 0),
      rotation: vec3(0, 0, 45),
      scale: vec3(2, 1, 1),
    };
    const L = localMatrix(transform.anchor, transform.position, transform.rotation, transform.scale);
    const compPt = transformPoint(L, vec3(30, 40, 0));
    const local = compToObjectLocal(compPt, identity(), transform);
    expect(local?.x).toBeCloseTo(30, 4);
    expect(local?.y).toBeCloseTo(40, 4);
  });
});

describe("previewViewer — §25.3 transform edits", () => {
  it("movedPosition applies comp delta in parent space", () => {
    const start = vec3(100, 50, 0);
    const next = movedPosition(start, identity(), vec3(20, 10, 0));
    expect(next.x).toBeCloseTo(120, 6);
    expect(next.y).toBeCloseTo(60, 6);
  });

  it("compensatePositionForAnchor keeps anchor world still (no rotation)", () => {
    const pos = vec3(200, 100, 0);
    const nextPos = compensatePositionForAnchor(pos, vec3(0, 0, 0), vec3(1, 1, 1), vec3(0, 0, 0), vec3(50, 25, 0));
    expect(nextPos.x).toBeCloseTo(250, 6);
    expect(nextPos.y).toBeCloseTo(125, 6);
  });

  it("anchorCompPosition matches L · anchor", () => {
    const t = {
      anchor: vec3(50, 50, 0),
      position: vec3(300, 200, 0),
      rotation: vec3(0, 0, 0),
      scale: vec3(1, 1, 1),
    };
    const L = localMatrix(t.anchor, t.position, t.rotation, t.scale);
    const expected = transformPoint(L, t.anchor);
    const got = anchorCompPosition(identity(), t);
    expect(got.x).toBeCloseTo(expected.x, 6);
    expect(got.y).toBeCloseTo(expected.y, 6);
  });

  it("parentWorldMatrix composes parent chain", () => {
    const parent = makeObject({
      id: "p",
      transform: {
        ...defaultTransform(),
        position: staticProp(vec3(100, 0, 0)),
      },
    });
    const child = makeObject({
      id: "c",
      parent: "p",
      transform: {
        ...defaultTransform(),
        position: staticProp(vec3(10, 0, 0)),
      },
    });
    const c = comp([parent, child]);
    const pw = parentWorldMatrix(c, "c", 0);
    const origin = transformPoint(pw, vec3(0, 0, 0));
    expect(origin.x).toBeCloseTo(100, 6);
  });

  it("scaleFromOppositeCorner keeps fixed corner in comp (anchor offset, SE handle)", () => {
    const bounds = { minX: 0, minY: 0, maxX: 400, maxY: 300 };
    const start = {
      anchor: vec3(200, 150, 0),
      position: vec3(500, 400, 0),
      rotation: vec3(0, 0, 0),
      scale: vec3(1, 1, 1),
    };
    const startWorld = localMatrix(start.anchor, start.position, start.rotation, start.scale);
    const fixedLocal = oppositeControlPoint(bounds, "se");
    const fixedComp = transformPoint(startWorld, fixedLocal);
    const handleCompStart = transformPoint(startWorld, handleControlPoint(bounds, "se"));
    const startComp = handleCompStart;
    const curComp = {
      x: fixedComp.x + (handleCompStart.x - fixedComp.x) * 1.2,
      y: fixedComp.y + (handleCompStart.y - fixedComp.y) * 1.2,
      z: 0,
    };

    const result = scaleFromOppositeCorner(start, bounds, "se", fixedComp, startComp, curComp, identity(), false);

    const afterWorld = localMatrix(start.anchor, result.position, start.rotation, result.scale);
    const fixedAfter = transformPoint(afterWorld, fixedLocal);
    expect(fixedAfter.x).toBeCloseTo(fixedComp.x, 4);
    expect(fixedAfter.y).toBeCloseTo(fixedComp.y, 4);
    expect(result.scale.x).toBeCloseTo(1.2, 4);
    expect(result.scale.y).toBeCloseTo(1.2, 4);
  });

  it("scaleFromOppositeCorner NW handle fixes SE corner (anchor offset)", () => {
    const bounds = { minX: 0, minY: 0, maxX: 400, maxY: 300 };
    const start = {
      anchor: vec3(200, 150, 0),
      position: vec3(500, 400, 0),
      rotation: vec3(0, 0, 0),
      scale: vec3(1, 1, 1),
    };
    const startWorld = localMatrix(start.anchor, start.position, start.rotation, start.scale);
    const fixedLocal = oppositeControlPoint(bounds, "nw");
    const fixedComp = transformPoint(startWorld, fixedLocal);
    const handleCompStart = transformPoint(startWorld, handleControlPoint(bounds, "nw"));
    const startComp = handleCompStart;
    const curComp = {
      x: fixedComp.x + (handleCompStart.x - fixedComp.x) * 0.8,
      y: fixedComp.y + (handleCompStart.y - fixedComp.y) * 0.8,
      z: 0,
    };

    const result = scaleFromOppositeCorner(start, bounds, "nw", fixedComp, startComp, curComp, identity(), false);
    const afterWorld = localMatrix(start.anchor, result.position, start.rotation, result.scale);
    const fixedAfter = transformPoint(afterWorld, fixedLocal);
    expect(fixedAfter.x).toBeCloseTo(fixedComp.x, 4);
    expect(fixedAfter.y).toBeCloseTo(fixedComp.y, 4);
    expect(result.scale.x).toBeCloseTo(0.8, 4);
    expect(result.scale.y).toBeCloseTo(0.8, 4);
  });

  it("scaleFromOppositeCorner does not jump when mousedown is offset on handle", () => {
    const bounds = { minX: 0, minY: 0, maxX: 120, maxY: 48 };
    const start = {
      anchor: vec3(0, 0, 0),
      position: vec3(100, 50, 0),
      rotation: vec3(0, 0, 0),
      scale: vec3(1, 1, 1),
    };
    const startWorld = localMatrix(start.anchor, start.position, start.rotation, start.scale);
    const fixedComp = transformPoint(startWorld, oppositeControlPoint(bounds, "se"));
    const handleCompStart = transformPoint(startWorld, handleControlPoint(bounds, "se"));
    const startComp = { x: handleCompStart.x + 3, y: handleCompStart.y - 2, z: 0 };

    const result = scaleFromOppositeCorner(
      start,
      bounds,
      "se",
      fixedComp,
      startComp,
      startComp,
      identity(),
      false,
    );

    expect(result.scale.x).toBeCloseTo(1, 5);
    expect(result.scale.y).toBeCloseTo(1, 5);
  });
});
