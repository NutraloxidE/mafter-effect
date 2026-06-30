import {
  compositionDir,
  PROJECT_JSON,
  scriptPath,
} from "../core/paths";
import { canonicalizeProject } from "../core/serialize";
import type {
  Component,
  Composition,
  HtmlComposition,
  Project,
  SceneObject,
  TimelineComposition,
} from "../core/schema";
import { globalPluginRegistry } from "./pluginRegistry";
import { collectExpressionPresetScriptPaths } from "./builtinExpressionPresetScripts";
import { resolveFootageAudioPath, resolveFootageVideoPath } from "./footagePlayback";
import { normalizeFootageQuality } from "./footageQuality";

export interface BundleCollectResult {
  timelineCompIds: Set<string>;
  htmlCompIds: Set<string>;
  textPaths: Set<string>;
  binaryPaths: Set<string>;
  livePluginIds: Set<string>;
}

const BUILTIN_COMPONENT_TYPES = new Set([
  "solid",
  "shape",
  "text",
  "image",
  "html",
  "comp",
  "audio",
  "video",
  "camera", // §6.5b 非描画（transform/メタのみ）。bundle で bake してはいけない
]);

function isTimelineComp(c: Composition | undefined): c is TimelineComposition {
  return c !== undefined && c.kind === "timeline";
}

function collectExpressionPaths(obj: SceneObject, out: Set<string>): void {
  const visitProp = (prop: unknown): void => {
    if (!prop || typeof prop !== "object") return;
    if ("expression" in prop) {
      const expr = (prop as { expression?: { path?: string; enabled?: boolean } }).expression;
      if (expr?.enabled && expr.path) out.add(expr.path);
    }
    if ("keyframes" in prop) return;
  };

  visitProp(obj.opacity);
  for (const key of ["anchor", "position", "rotation", "scale"] as const) {
    visitProp(obj.transform[key]);
  }
  for (const cmp of obj.components) {
    for (const val of Object.values(cmp.props)) visitProp(val);
  }
  for (const fx of obj.effects ?? []) {
    for (const val of Object.values(fx.props)) visitProp(val);
  }
}

function collectAssetFromProp(val: unknown, project: Project, binaries: Set<string>): void {
  if (!val || typeof val !== "object" || !("value" in val)) return;
  const assetId = (val as { value: unknown }).value;
  if (typeof assetId !== "string") return;
  const asset = project.assets.find((a) => a.id === assetId);
  if (asset) binaries.add(asset.path);
}

function collectObjectAssets(obj: SceneObject, project: Project, binaries: Set<string>): void {
  for (const cmp of obj.components) {
    // §11.4b video はレイヤー quality で resolve した映像 path のみ同梱（原本全体は積まない）。
    // 内蔵音声付き native は原本 path も同梱（proxy tier でも音声は原本から再生）。
    if (cmp.type === "video") {
      const assetId = cmp.props["asset"];
      if (typeof assetId === "string") {
        const asset = project.assets.find((a) => a.id === assetId);
        if (asset) {
          const quality = normalizeFootageQuality(cmp.props["footageQuality"]);
          binaries.add(resolveFootageVideoPath(asset, quality));
          const audioPath = resolveFootageAudioPath(asset);
          if (audioPath) binaries.add(audioPath);
        }
      }
      continue;
    }
    for (const val of Object.values(cmp.props)) {
      collectAssetFromProp(val, project, binaries);
      if (typeof val === "string" && project.assets.some((a) => a.id === val)) {
        const asset = project.assets.find((a) => a.id === val);
        if (asset) binaries.add(asset.path);
      }
    }
    if (cmp.type === "image" || cmp.type === "audio") {
      const assetId = cmp.props["asset"];
      if (typeof assetId === "string") {
        const asset = project.assets.find((a) => a.id === assetId);
        if (asset) binaries.add(asset.path);
      }
    }
  }
}

export function componentNeedsBake(component: Component): boolean {
  if (component.exportStrategy === "live") return false;
  if (component.exportStrategy === "bake") return true;
  if (BUILTIN_COMPONENT_TYPES.has(component.type)) return false;
  const def = globalPluginRegistry.getComponentDef(component.type);
  if (!def) return false;
  return def.bundleExportDefault !== "live";
}

export function componentNeedsLivePlugin(component: Component): boolean {
  if (BUILTIN_COMPONENT_TYPES.has(component.type)) return false;
  if (componentNeedsBake(component)) return false;
  const def = globalPluginRegistry.getComponentDef(component.type);
  return def !== undefined;
}

/** ルート comp から bundle に含める FS パスを収集する（純関数・DOM 非依存）。 */
export function collectBundleDependencies(
  project: Project,
  rootCompId: string,
): BundleCollectResult {
  const timelineCompIds = new Set<string>();
  const htmlCompIds = new Set<string>();
  const textPaths = new Set<string>();
  const binaryPaths = new Set<string>();
  const livePluginIds = new Set<string>();
  let usesLivePlugin = false;

  textPaths.add(PROJECT_JSON);

  const queue = [rootCompId];
  while (queue.length > 0) {
    const compId = queue.pop()!;
    if (timelineCompIds.has(compId)) continue;
    const comp = project.compositions.find((c) => c.id === compId);
    if (!isTimelineComp(comp)) continue;
    timelineCompIds.add(compId);

    collectExpressionPresetScriptPaths(comp, textPaths);
    for (const obj of comp.objects) {
      collectExpressionPaths(obj, textPaths);
      collectObjectAssets(obj, project, binaryPaths);

      for (const cmp of obj.components) {
        if (cmp.type === "comp") {
          const nestedId = cmp.props["compId"];
          if (typeof nestedId === "string") queue.push(nestedId);
        }
        if (cmp.type === "html") {
          const htmlId = cmp.props["compId"];
          if (typeof htmlId === "string") htmlCompIds.add(htmlId);
        }
        if (componentNeedsLivePlugin(cmp)) usesLivePlugin = true;
      }
    }
  }

  if (usesLivePlugin) {
    for (const ref of project.pluginRefs) {
      if (ref.enabled) livePluginIds.add(ref.id);
    }
  }

  for (const htmlId of htmlCompIds) {
    const dir = compositionDir(htmlId);
    textPaths.add(`${dir}/script.js`);
    textPaths.add(`${dir}/index.html`);
    textPaths.add(`${dir}/style.css`);
  }

  return {
    timelineCompIds,
    htmlCompIds,
    textPaths,
    binaryPaths,
    livePluginIds,
  };
}

/** expression path から objectId/param を推定して scriptPath を登録する補助。 */
export function expandScriptPaths(textPaths: Set<string>): void {
  for (const p of [...textPaths]) {
    if (p.startsWith("scripts/") && p.endsWith(".js")) {
      textPaths.add(p);
    }
  }
}

export function scriptPathsForObject(obj: SceneObject): string[] {
  const paths: string[] = [];
  const visit = (prop: unknown, param: string): void => {
    if (!prop || typeof prop !== "object" || !("expression" in prop)) return;
    const expr = (prop as { expression?: { path?: string; enabled?: boolean } }).expression;
    if (expr?.enabled && expr.path) paths.push(expr.path);
    else if (expr?.enabled) paths.push(scriptPath(obj.id, param));
  };
  visit(obj.opacity, "opacity");
  for (const key of ["anchor", "position", "rotation", "scale"] as const) {
    visit(obj.transform[key], key);
  }
  return paths;
}

export function canonicalBundleProject(project: Project): Project {
  return canonicalizeProject(project);
}

export function htmlCompositionsInProject(
  project: Project,
  htmlCompIds: Set<string>,
): HtmlComposition[] {
  return project.compositions.filter(
    (c): c is HtmlComposition => c.kind === "html" && htmlCompIds.has(c.id),
  );
}

export function timelineCompositionsInProject(
  project: Project,
  ids: Set<string>,
): TimelineComposition[] {
  return project.compositions.filter(
    (c): c is TimelineComposition => c.kind === "timeline" && ids.has(c.id),
  );
}
