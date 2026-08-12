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
import { BUILTIN_COMPONENT_TYPES } from "./builtinComponents";
import { collectExpressionPresetScriptPaths } from "./builtinExpressionPresetScripts";
import { footagePathsForComponent } from "./renderDependencies";

export interface BundleCollectResult {
  timelineCompIds: Set<string>;
  htmlCompIds: Set<string>;
  textPaths: Set<string>;
  binaryPaths: Set<string>;
  livePluginIds: Set<string>;
  /**
   * §11.7 — root comp から到達可能なオブジェクトが実際に参照する asset の id。
   * `bundleExporter.ts` が `project.json` に埋め込む `assets[]`/`compositions[]` を
   * このプロジェクト全体ではなく到達可能な範囲だけへ削るために使う（無関係な他 comp の
   * asset を含めると bundle player がそれらも読み込もうとし 404 になる — 実害は無いが
   * bundle サイズ膨張 + 起動時の無駄な fetch のノイズになる）。
   */
  assetIds: Set<string>;
}

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

function collectAssetFromProp(
  val: unknown,
  project: Project,
  binaries: Set<string>,
  assetIds: Set<string>,
): void {
  if (!val || typeof val !== "object" || !("value" in val)) return;
  const assetId = (val as { value: unknown }).value;
  if (typeof assetId !== "string") return;
  const asset = project.assets.find((a) => a.id === assetId);
  if (asset) {
    binaries.add(asset.path);
    assetIds.add(asset.id);
  }
}

function collectObjectAssets(
  obj: SceneObject,
  project: Project,
  binaries: Set<string>,
  assetIds: Set<string>,
): void {
  for (const cmp of obj.components) {
    // §11.4b video はレイヤー quality で resolve した映像 path のみ同梱（原本全体は積まない）。
    // 内蔵音声付き native は原本 path も同梱（proxy tier でも音声は原本から再生）。
    if (cmp.type === "video") {
      const assetId = cmp.props["asset"];
      if (typeof assetId === "string" && project.assets.some((a) => a.id === assetId)) {
        assetIds.add(assetId);
        // §11.4b/§16.2/§16.2b — quality tier・内蔵音声・split alpha companion の解決は
        // `footagePathsForComponent` が唯一の正（swarm の worker 転送と同じ定義を使う）。
        // bundle player は live 再生なので exportStep: false。
        for (const path of footagePathsForComponent(project, cmp, { exportStep: false })) {
          binaries.add(path);
        }
      }
      continue;
    }
    for (const val of Object.values(cmp.props)) {
      collectAssetFromProp(val, project, binaries, assetIds);
      if (typeof val === "string" && project.assets.some((a) => a.id === val)) {
        const asset = project.assets.find((a) => a.id === val);
        if (asset) {
          binaries.add(asset.path);
          assetIds.add(asset.id);
        }
      }
    }
    if (cmp.type === "image" || cmp.type === "audio") {
      const assetId = cmp.props["asset"];
      if (typeof assetId === "string") {
        const asset = project.assets.find((a) => a.id === assetId);
        if (asset) {
          binaries.add(asset.path);
          assetIds.add(asset.id);
        }
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
  const assetIds = new Set<string>();
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
      collectObjectAssets(obj, project, binaryPaths, assetIds);

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
    assetIds,
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

/**
 * §11.7 — `project.json` に埋め込む前に、root comp から到達不能な comp/asset を削る。
 * `collectBundleDependencies` は「FS から読むべきバイナリ/テキストの path」を集めるためのもの
 * だったが、埋め込む `project`（`Project.compositions`/`Project.assets`）自体は従来
 * プロジェクト全体を無加工でそのまま埋めていた。bundle player は `project.assets` を無条件に
 * 走査してプリロードを試みるため、無関係な他 comp の asset が大量に混ざっていると
 * 存在しない proxy/バイナリへの 404 フェッチが多発し（実害は無いが起動時のノイズ・帯域の無駄）、
 * かつ全 comp の分だけ `project.json` が肥大化する。純関数・`resolve()` 契約には影響しない
 * （resolve は渡された comp の中だけしか見ないため、削っても対象 comp の解決値は不変）。
 */
export function pruneProjectToBundleScope(
  project: Project,
  rootCompId: string,
  scope: Pick<BundleCollectResult, "timelineCompIds" | "htmlCompIds" | "assetIds">,
): Project {
  const keepCompIds = new Set<string>([...scope.timelineCompIds, ...scope.htmlCompIds]);
  return {
    ...project,
    rootComposition: rootCompId,
    compositions: project.compositions.filter((c) => keepCompIds.has(c.id)),
    assets: project.assets.filter((a) => scope.assetIds.has(a.id)),
  };
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
