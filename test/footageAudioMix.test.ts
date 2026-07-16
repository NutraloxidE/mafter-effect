import { describe, expect, it } from "vitest";
import { defaultTransform, staticProp } from "../src/core/props";
import type { Component, SceneObject, TimelineComposition } from "../src/core/schema";
import { collectFootageAudioSources, sampleGain } from "../src/runtime/footageAudio";

function obj(id: string, components: Component[], enabled = true): SceneObject {
  return {
    id,
    name: id,
    parent: null,
    zOrder: 1,
    enabled,
    inPoint: 0,
    outPoint: 100,
    transform: defaultTransform(),
    opacity: staticProp(1),
    components,
  };
}

function comp(objects: SceneObject[]): TimelineComposition {
  return {
    id: "c0",
    name: "c0",
    kind: "timeline",
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 100,
    objects,
  };
}

describe("collectFootageAudioSources (§11.4 / §11.5)", () => {
  it("collects audio layers with their gainProp and trimStart (plain gain compat)", () => {
    const sources = collectFootageAudioSources(
      comp([obj("a", [{ type: "audio", props: { asset: "snd", gain: 0.5, trimStart: 7 } }])]),
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ assetId: "snd", trimStart: 7, componentType: "audio" });
    expect(sampleGain(sources[0]!.gainProp, 0)).toBe(0.5);
  });

  it("collects video layers with gainProp (defaults to 1 when absent)", () => {
    const sources = collectFootageAudioSources(
      comp([obj("v", [{ type: "video", props: { asset: "clip", trimStart: 3 } }])]),
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ assetId: "clip", trimStart: 3, componentType: "video" });
    expect(sampleGain(sources[0]!.gainProp, 0)).toBe(1);
  });

  it("reads an animated video gain", () => {
    const sources = collectFootageAudioSources(
      comp([
        obj("v", [
          {
            type: "video",
            props: {
              asset: "clip",
              gain: {
                value: 0,
                keyframes: [
                  { frame: 0, value: 0, easing: { type: "linear" } },
                  { frame: 30, value: 1, easing: { type: "linear" } },
                ],
              },
            },
          },
        ]),
      ]),
    );
    expect(sampleGain(sources[0]!.gainProp, 0)).toBe(0);
    expect(sampleGain(sources[0]!.gainProp, 15)).toBeCloseTo(0.5, 6);
    expect(sampleGain(sources[0]!.gainProp, 30)).toBe(1);
  });

  it("collects both audio and video layers together", () => {
    const sources = collectFootageAudioSources(
      comp([
        obj("a", [{ type: "audio", props: { asset: "snd", gain: 1, trimStart: 0 } }]),
        obj("v", [{ type: "video", props: { asset: "clip", trimStart: 0 } }]),
      ]),
    );
    expect(sources.map((s) => s.assetId).sort()).toEqual(["clip", "snd"]);
  });

  it("skips disabled layers", () => {
    const sources = collectFootageAudioSources(
      comp([obj("v", [{ type: "video", props: { asset: "clip" } }], false)]),
    );
    expect(sources).toHaveLength(0);
  });

  it("skips layers without an asset", () => {
    const sources = collectFootageAudioSources(
      comp([
        obj("v", [{ type: "video", props: {} }]),
        obj("a", [{ type: "audio", props: {} }]),
      ]),
    );
    expect(sources).toHaveLength(0);
  });

  it("defaults trimStart to 0 when absent", () => {
    const sources = collectFootageAudioSources(
      comp([obj("v", [{ type: "video", props: { asset: "clip" } }])]),
    );
    expect(sources[0]).toMatchObject({ trimStart: 0 });
    expect(sampleGain(sources[0]!.gainProp, 0)).toBe(1);
  });

  it("recurses into nested comp layers when resolveComp is given, mapping inPoint/outPoint into root frames", () => {
    const inner = comp([obj("a", [{ type: "audio", props: { asset: "snd", gain: 1 } }])]);
    inner.id = "inner";
    // outer places the precomp at root inPoint=10 (same fps, no trim).
    const outerLayer: SceneObject = {
      ...obj("nested", [{ type: "comp", props: { compId: "inner" } }]),
      inPoint: 10,
      outPoint: 60,
    };
    const outer = comp([outerLayer]);
    const sources = collectFootageAudioSources(outer, (id) => (id === "inner" ? inner : undefined));
    expect(sources).toHaveLength(1);
    // inner audio's own inPoint=0/outPoint=100 shifted by the precomp layer's root inPoint=10,
    // then clamped by nothing here (test keeps it simple: same fps, trimStart=0).
    expect(sources[0]).toMatchObject({ assetId: "snd", inPoint: 10, outPoint: 110 });
  });

  it("converts a nested layer's trimStart into root fps units so media seek stays fps-independent", () => {
    // inner is 60fps, root is 30fps. trimStart=120 inner frames = 2.0s into the source.
    const inner = comp([obj("a", [{ type: "audio", props: { asset: "snd", gain: 1, trimStart: 120 } }])]);
    inner.id = "inner";
    inner.fps = 60;
    const outer = comp([obj("nested", [{ type: "comp", props: { compId: "inner" } }])]);
    const sources = collectFootageAudioSources(outer, (id) => (id === "inner" ? inner : undefined));
    // consumers all compute media seconds as trimStart / rootFps — must land on 2.0s, not 4.0s.
    expect(sources[0]!.trimStart / outer.fps).toBeCloseTo(2, 6);
  });

  it("remaps animated gain keyframes of a nested layer into root frames", () => {
    const inner = comp([
      obj("a", [
        {
          type: "audio",
          props: {
            asset: "snd",
            gain: {
              value: 0,
              keyframes: [
                { frame: 0, value: 0, easing: { type: "linear" } },
                { frame: 30, value: 1, easing: { type: "linear" } },
              ],
            },
          },
        },
      ]),
    ]);
    inner.id = "inner";
    const outerLayer: SceneObject = {
      ...obj("nested", [{ type: "comp", props: { compId: "inner" } }]),
      inPoint: 10,
      outPoint: 60,
    };
    const outer = comp([outerLayer]);
    const sources = collectFootageAudioSources(outer, (id) => (id === "inner" ? inner : undefined));
    // keyframe frame=0 (inner-local) is at root frame 10; frame=30 is at root frame 40.
    expect(sampleGain(sources[0]!.gainProp, 10)).toBe(0);
    expect(sampleGain(sources[0]!.gainProp, 40)).toBe(1);
    expect(sampleGain(sources[0]!.gainProp, 25)).toBeCloseTo(0.5, 6);
  });

  it("does not recurse into nested comps when resolveComp is omitted (backward compat)", () => {
    const inner = comp([obj("a", [{ type: "audio", props: { asset: "snd" } }])]);
    inner.id = "inner";
    const outer = comp([obj("nested", [{ type: "comp", props: { compId: "inner" } }])]);
    expect(collectFootageAudioSources(outer)).toHaveLength(0);
  });
});
