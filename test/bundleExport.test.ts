import { describe, expect, it } from "vitest";
import { presetExpressionScriptPath } from "../src/core/paths";
import type { Project, TimelineComposition } from "../src/core/schema";
import {
  collectBundleDependencies,
  componentNeedsBake,
  canonicalBundleProject,
} from "../src/runtime/bundleCollect";
import { injectBuiltinExpressionPresetScripts } from "../src/runtime/builtinExpressionPresetScripts";
import { findBakeTargets } from "../src/runtime/bundleBake";
import { globalPluginRegistry } from "../src/runtime/pluginRegistry";
import { registerBuiltinComponents } from "../src/runtime/builtinComponents";
import type { ComponentDef } from "../src/runtime/plugin";

function minimalProject(objects: TimelineComposition["objects"]): Project {
  const compId = "01COMPROOT0000000000000001";
  const comp: TimelineComposition = {
    id: compId,
    name: "Main",
    kind: "timeline",
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 90,
    objects,
  };
  return {
    schemaVersion: 1,
    meta: { name: "Test", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    assets: [],
    compositions: [comp],
    rootComposition: compId,
    pluginRefs: [],
  };
}

describe("bundleCollect", () => {
  it("collects nested comp and image asset paths", () => {
    const childId = "01COMPCHILD000000000000001";
    const imageAsset = "01ASSETIMG000000000000001";
    const project: Project = {
      ...minimalProject([]),
      compositions: [
        {
          id: "01COMPROOT0000000000000001",
          name: "Main",
          kind: "timeline",
          width: 1920,
          height: 1080,
          fps: 30,
          duration: 90,
          objects: [
            {
              id: "01OBJ00000000000000000001",
              name: "Precomp",
              parent: null,
              zOrder: 1,
              enabled: true,
              inPoint: 0,
              outPoint: 90,
              transform: {
                anchor: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
                position: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
                rotation: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
                scale: { value: { x: 1, y: 1, z: 1 }, keyframes: [] },
              },
              opacity: { value: 1, keyframes: [] },
              components: [{ type: "comp", props: { compId: childId } }],
            },
          ],
        },
        {
          id: childId,
          name: "Child",
          kind: "timeline",
          width: 1920,
          height: 1080,
          fps: 30,
          duration: 60,
          objects: [
            {
              id: "01OBJ00000000000000000002",
              name: "Img",
              parent: null,
              zOrder: 1,
              enabled: true,
              inPoint: 0,
              outPoint: 60,
              transform: {
                anchor: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
                position: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
                rotation: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
                scale: { value: { x: 1, y: 1, z: 1 }, keyframes: [] },
              },
              opacity: { value: 1, keyframes: [] },
              components: [{ type: "image", props: { asset: imageAsset, fit: "contain" } }],
            },
          ],
        },
      ],
      assets: [
        { id: imageAsset, path: "assets/photo.png", kind: "image", meta: { width: 100, height: 100 } },
      ],
    };

    const deps = collectBundleDependencies(project, "01COMPROOT0000000000000001");
    expect(deps.timelineCompIds.has("01COMPROOT0000000000000001")).toBe(true);
    expect(deps.timelineCompIds.has(childId)).toBe(true);
    expect(deps.binaryPaths.has("assets/photo.png")).toBe(true);
  });

  it("collects split-alpha companion webm path for video layers (§16.2)", () => {
    const videoAsset = "01ASSETVID000000000000001";
    const project: Project = {
      ...minimalProject([
        {
          id: "01OBJ00000000000000000009",
          name: "Person",
          parent: null,
          zOrder: 1,
          enabled: true,
          inPoint: 0,
          outPoint: 90,
          transform: {
            anchor: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
            position: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
            rotation: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
            scale: { value: { x: 1, y: 1, z: 1 }, keyframes: [] },
          },
          opacity: { value: 1, keyframes: [] },
          components: [{ type: "video", props: { asset: videoAsset, fit: "contain" } }],
        },
      ]),
      assets: [
        {
          id: videoAsset,
          path: "assets/person.webm",
          kind: "video",
          meta: {
            width: 1920,
            height: 1080,
            hasAlpha: true,
            alphaMode: "split",
            alphaPath: "assets/person.alpha.webm",
          },
        },
      ],
    };

    const deps = collectBundleDependencies(project, "01COMPROOT0000000000000001");
    expect(deps.binaryPaths.has("assets/person.webm")).toBe(true);
    expect(deps.binaryPaths.has("assets/person.alpha.webm")).toBe(true);
  });

  it("packed alpha: bundles the resolved preview-quality proxy file, not the raw footageQuality/original (§16.2b regression)", () => {
    // §16.2b: bundle player registers ALL meta.proxies URLs unconditionally (registerProjectUrls),
    // so whichever proxy tier effectivePackedQuality resolves to for live playback MUST be the
    // file that actually gets bundled — otherwise the player 404s trying to fetch a proxy that
    // was never copied into the zip. Default (unset) footageQuality resolves to the packed
    // default proxy tier ("low"), not "original", so the "low" proxy file must be the one bundled.
    const videoAsset = "01ASSETPACKED00000000001";
    const project: Project = {
      ...minimalProject([
        {
          id: "01OBJ0000000000000000000A",
          name: "PackedPerson",
          parent: null,
          zOrder: 1,
          enabled: true,
          inPoint: 0,
          outPoint: 90,
          transform: {
            anchor: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
            position: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
            rotation: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
            scale: { value: { x: 1, y: 1, z: 1 }, keyframes: [] },
          },
          opacity: { value: 1, keyframes: [] },
          // footageQuality left unset → effectivePackedQuality substitutes the default proxy tier.
          components: [{ type: "video", props: { asset: videoAsset, fit: "contain" } }],
        },
      ]),
      assets: [
        {
          id: videoAsset,
          path: "assets/packed.webm",
          kind: "video",
          meta: {
            width: 1080,
            height: 1920,
            hasAlpha: true,
            alphaMode: "packed",
            packedLayout: "topBottom",
            contentHeight: 1138,
            gutterPx: 8,
            proxies: { low: { path: "assets/packed.low.webm", mime: "video/webm" } },
          },
        },
      ],
    };

    const deps = collectBundleDependencies(project, "01COMPROOT0000000000000001");
    expect(deps.binaryPaths.has("assets/packed.low.webm")).toBe(true);
    // 原本もバンドルされる — packed proxy は映像のみ（音声を含まない）ため、内蔵音声は
    // 常に原本から再生する（resolveFootageAudioPath は quality 非依存で常に原本を返す）。
    // ここでの regression 対象はあくまで「video 側が正しい proxy tier を使うこと」。
    expect(deps.binaryPaths.has("assets/packed.webm")).toBe(true);
  });

  it("packed alpha: footageQuality='same_as_export' bundles the packedExportQuality proxy (§16.2b)", () => {
    const videoAsset = "01ASSETPACKED00000000002";
    const project: Project = {
      ...minimalProject([
        {
          id: "01OBJ0000000000000000000B",
          name: "PackedLinked",
          parent: null,
          zOrder: 1,
          enabled: true,
          inPoint: 0,
          outPoint: 90,
          transform: {
            anchor: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
            position: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
            rotation: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
            scale: { value: { x: 1, y: 1, z: 1 }, keyframes: [] },
          },
          opacity: { value: 1, keyframes: [] },
          components: [{
            type: "video",
            props: { asset: videoAsset, fit: "contain", footageQuality: "same_as_export", packedExportQuality: "medium" },
          }],
        },
      ]),
      assets: [
        {
          id: videoAsset,
          path: "assets/packed2.webm",
          kind: "video",
          meta: {
            width: 1080,
            height: 1920,
            hasAlpha: true,
            alphaMode: "packed",
            packedLayout: "topBottom",
            contentHeight: 1138,
            gutterPx: 8,
            proxies: {
              low: { path: "assets/packed2.low.webm", mime: "video/webm" },
              medium: { path: "assets/packed2.medium.webm", mime: "video/webm" },
            },
          },
        },
      ],
    };

    const deps = collectBundleDependencies(project, "01COMPROOT0000000000000001");
    expect(deps.binaryPaths.has("assets/packed2.medium.webm")).toBe(true);
    expect(deps.binaryPaths.has("assets/packed2.low.webm")).toBe(false);
    // 原本もバンドルされる（内蔵音声は quality 非依存で常に原本、上のテストと同じ理由）。
    expect(deps.binaryPaths.has("assets/packed2.webm")).toBe(true);
  });

  it("componentNeedsBake respects plugin default bake", () => {
    registerBuiltinComponents();
    globalPluginRegistry.registerComponent({
      type: "test-plugin-layer",
      label: "Test",
      previewBakeRequired: false,
      params: [],
      bundleExportDefault: "bake",
      render() { /* noop */ },
    } as ComponentDef);

    expect(componentNeedsBake({ type: "solid", props: {} })).toBe(false);
    // §5.5c shape rect/ellipse/path のいずれも builtin なので既定 bake（誤 bake）にならない。
    expect(componentNeedsBake({ type: "shape", props: { kind: "rect" } })).toBe(false);
    expect(componentNeedsBake({ type: "shape", props: { kind: "path", vertices: [] } })).toBe(false);
    expect(componentNeedsBake({ type: "test-plugin-layer", props: {} })).toBe(true);
    expect(componentNeedsBake({ type: "test-plugin-layer", props: {}, exportStrategy: "live" })).toBe(false);
  });

  it("findBakeTargets lists plugin layers", () => {
    const project = minimalProject([
      {
        id: "01OBJ00000000000000000003",
        name: "Plugin",
        parent: null,
        zOrder: 1,
        enabled: true,
        inPoint: 0,
        outPoint: 90,
        transform: {
          anchor: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
          position: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
          rotation: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
          scale: { value: { x: 1, y: 1, z: 1 }, keyframes: [] },
        },
        opacity: { value: 1, keyframes: [] },
        components: [{ type: "test-plugin-layer", props: {} }],
      },
    ]);
    globalPluginRegistry.registerComponent({
      type: "test-plugin-layer",
      label: "Test",
      previewBakeRequired: false,
      params: [],
      bundleExportDefault: "bake",
      render() { /* noop */ },
    } as ComponentDef);

    const deps = collectBundleDependencies(project, "01COMPROOT0000000000000001");
    const targets = findBakeTargets(project, deps.timelineCompIds);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.objectId).toBe("01OBJ00000000000000000003");
  });

  it("camera layer is a builtin → never bundle-baked (§6.5b)", () => {
    registerBuiltinComponents();
    expect(componentNeedsBake({ type: "camera", props: { zoom: { value: 1158, keyframes: [] } } })).toBe(false);
  });

  it("camera + effect-only adjustment layers produce no bake targets (regression)", () => {
    // ユーザー報告: built-in live エフェクト(blur/fastTurbulent)+カメラのみのコンプが
    // Static HTML 書き出しで「plugin / bake レイヤ 1 件」になっていた（= camera 誤判定）。
    registerBuiltinComponents();
    const tf = () => ({
      anchor: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
      position: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
      rotation: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
      scale: { value: { x: 1, y: 1, z: 1 }, keyframes: [] },
    });
    const project = minimalProject([
      {
        id: "01OBJADJ0000000000000000001",
        name: "Adjustment",
        parent: null, zOrder: 1, enabled: true, inPoint: 0, outPoint: 90,
        transform: tf(), opacity: { value: 1, keyframes: [] },
        components: [],
        isAdjustment: true,
        effects: [
          { id: "fx1", type: "blur", enabled: true, props: { blurriness: { value: 41.8, keyframes: [] } } },
          { id: "fx2", type: "fastTurbulentDisplace", enabled: true, props: { amount: { value: 68.2, keyframes: [] } } },
        ],
      },
      {
        id: "01OBJCAM0000000000000000001",
        name: "Camera 1",
        parent: null, zOrder: 2, enabled: true, inPoint: 0, outPoint: 90,
        transform: tf(), opacity: { value: 1, keyframes: [] },
        components: [{ type: "camera", props: { cameraType: "two-node", zoom: { value: 1158, keyframes: [] } } }],
      },
    ]);
    const deps = collectBundleDependencies(project, "01COMPROOT0000000000000001");
    expect(findBakeTargets(project, deps.timelineCompIds)).toHaveLength(0);
  });

  it("canonicalBundleProject sorts compositions by id", () => {
    const p = minimalProject([]);
    const c = canonicalBundleProject(p);
    expect(c.compositions[0]?.id).toBe("01COMPROOT0000000000000001");
  });

  it("collects builtin expression preset script paths (§9 Phase 0.5)", () => {
    const presetPath = presetExpressionScriptPath("wiggle-position");
    const project = minimalProject([
      {
        id: "01OBJ00000000000000000004",
        name: "Wiggle",
        parent: null,
        zOrder: 1,
        enabled: true,
        inPoint: 0,
        outPoint: 90,
        transform: {
          anchor: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
          position: {
            value: { x: 0, y: 0, z: 0 },
            keyframes: [],
            expression: { path: presetPath, enabled: true },
          },
          rotation: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
          scale: { value: { x: 1, y: 1, z: 1 }, keyframes: [] },
        },
        opacity: { value: 1, keyframes: [] },
        components: [{ type: "solid", props: { color: { value: { r: 1, g: 0, b: 0, a: 1 }, keyframes: [] } } }],
        expressionPresets: [
          {
            id: "01EXPRINST00000000000001",
            presetId: "wiggle-position",
            enabled: true,
            props: {
              frequency: { value: 2, keyframes: [] },
              amplitude: { value: 60, keyframes: [] },
              seed: { value: 0, keyframes: [] },
            },
          },
        ],
      },
    ]);
    const deps = collectBundleDependencies(project, "01COMPROOT0000000000000001");
    expect(deps.textPaths.has(presetPath)).toBe(true);
  });

  it("injectBuiltinExpressionPresetScripts fills manifest textFiles without FS", () => {
    const presetPath = presetExpressionScriptPath("oscillate-position");
    const project = minimalProject([
      {
        id: "01OBJ00000000000000000005",
        name: "Osc",
        parent: null,
        zOrder: 1,
        enabled: true,
        inPoint: 0,
        outPoint: 90,
        transform: {
          anchor: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
          position: {
            value: { x: 0, y: 0, z: 0 },
            keyframes: [],
            expression: { path: presetPath, enabled: true },
          },
          rotation: { value: { x: 0, y: 0, z: 0 }, keyframes: [] },
          scale: { value: { x: 1, y: 1, z: 1 }, keyframes: [] },
        },
        opacity: { value: 1, keyframes: [] },
        components: [{ type: "solid", props: { color: { value: { r: 0, g: 1, b: 0, a: 1 }, keyframes: [] } } }],
        expressionPresets: [
          {
            id: "01EXPRINST00000000000002",
            presetId: "oscillate-position",
            enabled: true,
            props: {
              amplitude: { value: 30, keyframes: [] },
              frequency: { value: 1, keyframes: [] },
            },
          },
        ],
      },
    ]);
    const textFiles: Record<string, string> = {};
    injectBuiltinExpressionPresetScripts(project, textFiles);
    expect(textFiles[presetPath]).toContain("@mafter:preset oscillate-position");
    expect(textFiles[presetPath]).toContain("presetParams");
  });
});
