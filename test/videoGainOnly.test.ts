import { describe, expect, it } from "vitest";
import { resolveVideoGainForFrame } from "../src/runtime/videoGainOnly";
import { resolve } from "../src/runtime/resolve";
import { defaultTransform, staticProp } from "../src/core/props";
import type { SceneObject, TimelineComposition } from "../src/core/schema";

// fix-plan-v2-minimal: この軽量関数は resolve() の video gain 計算（transform/effect 抜き）を
// 再現する。二重実装が drift しないことを resolve() とのパリティで固定する。

function videoObject(over: Partial<SceneObject> & { id: string; assetId?: string }): SceneObject {
  const { assetId = "asset-1", ...rest } = over;
  return {
    name: over.id,
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: 90,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components: [{ type: "video", props: { asset: assetId, gain: staticProp(1) } }],
    ...rest,
  };
}

function comp(objects: SceneObject[], extra: Partial<TimelineComposition> = {}): TimelineComposition {
  return {
    id: "C",
    name: "Main",
    kind: "timeline",
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 90,
    objects,
    ...extra,
  };
}

function gainFromResolve(c: TimelineComposition, frame: number, objectId: string): number | undefined {
  const scene = resolve(c, frame);
  const obj = scene.objects.find((o) => o.id === objectId);
  const video = obj?.components.find((rc) => rc.type === "video");
  const g = video?.props["gain"];
  return typeof g === "number" ? g : undefined;
}

describe("resolveVideoGainForFrame — parity with resolve()'s embedded declick math", () => {
  it("matches resolve()'s video gain (raw × autoFade) at every frame of a 90-frame clip", () => {
    const c = comp([videoObject({ id: "v" })]);
    for (let frame = 0; frame < 90; frame++) {
      const light = resolveVideoGainForFrame(c, frame).get("v");
      const heavy = gainFromResolve(c, frame, "v");
      expect(light).toBeCloseTo(heavy ?? -1, 9);
    }
  });

  it("ramps up from ~0 at the in-point and down to ~0 at the out-point (declick fade is active)", () => {
    const c = comp([videoObject({ id: "v" })]);
    const first = resolveVideoGainForFrame(c, 0).get("v")!;
    const mid = resolveVideoGainForFrame(c, 45).get("v")!;
    const last = resolveVideoGainForFrame(c, 89).get("v")!;
    expect(first).toBeLessThan(mid);
    expect(last).toBeLessThan(mid);
    expect(mid).toBeCloseTo(1, 6);
  });

  it("excludes objects outside their visible frame range", () => {
    const c = comp([videoObject({ id: "v", inPoint: 30, outPoint: 60 })]);
    expect(resolveVideoGainForFrame(c, 10).has("v")).toBe(false);
    expect(resolveVideoGainForFrame(c, 90).has("v")).toBe(false);
    expect(resolveVideoGainForFrame(c, 45).has("v")).toBe(true);
  });

  it("excludes disabled objects", () => {
    const c = comp([videoObject({ id: "v", enabled: false })]);
    expect(resolveVideoGainForFrame(c, 10).has("v")).toBe(false);
  });

  it("falls back to a plain-number gain prop (non-AnimatedProp)", () => {
    const obj = videoObject({ id: "v" });
    (obj.components[0]!.props as Record<string, unknown>)["gain"] = 0.5;
    const c = comp([obj]);
    // mid-clip so declick fade is ~1 and doesn't mask the raw gain value.
    expect(resolveVideoGainForFrame(c, 45).get("v")).toBeCloseTo(0.5, 6);
  });

  it("respects autoFade=false (no fade applied, raw gain used throughout)", () => {
    const obj = videoObject({ id: "v" });
    (obj.components[0]!.props as Record<string, unknown>)["autoFade"] = false;
    const c = comp([obj]);
    expect(resolveVideoGainForFrame(c, 0).get("v")).toBeCloseTo(1, 6);
    expect(resolveVideoGainForFrame(c, 89).get("v")).toBeCloseTo(1, 6);
  });

  it("ignores non-video components (no audio-only component leaks into the map)", () => {
    const obj = videoObject({ id: "v" });
    obj.components = [{ type: "solid", props: {} }];
    const c = comp([obj]);
    expect(resolveVideoGainForFrame(c, 45).size).toBe(0);
  });
});
