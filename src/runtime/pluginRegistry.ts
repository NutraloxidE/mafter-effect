// §12 PluginRegistry — Plugin の登録センター。
// DomRenderer / ExpressionEngine がここから ComponentDef / ExprHelper を引く。
// Store が loadPlugins() でここにロードし、グローバルシングルトンを共有する。

import type {
  ComponentDef,
  EasingPreset,
  EffectDef,
  ExporterDef,
  ImporterDef,
  InspectorControlDef,
  PluginContext,
  PluginManifest,
  PureFn,
  ReadonlyFileSystem,
} from "./plugin";

export class PluginRegistry {
  private readonly components = new Map<string, ComponentDef>();
  private readonly effects = new Map<string, EffectDef>();
  private readonly easings = new Map<string, EasingPreset>();
  private readonly exprHelpers = new Map<string, PureFn>();
  private readonly importers = new Map<string, ImporterDef>();
  private readonly exporters = new Map<string, ExporterDef>();
  private readonly inspectors: InspectorControlDef[] = [];
  private readonly _loadedManifests: PluginManifest[] = [];

  makeContext(fs: ReadonlyFileSystem): PluginContext {
    const self = this;
    return {
      registerComponent(def) { self.components.set(def.type, def); },
      registerEffect(def) { self.effects.set(def.type, def); },
      registerEasing(preset) { self.easings.set(preset.id, preset); },
      registerExprHelper(name, fn) { self.exprHelpers.set(name, fn); },
      registerImporter(def) { self.importers.set(def.id, def); },
      registerExporter(def) { self.exporters.set(def.id, def); },
      registerInspector(def) { self.inspectors.push(def); },
      fs,
    };
  }

  activate(
    manifest: PluginManifest,
    activateFn: (ctx: PluginContext) => void,
    fs: ReadonlyFileSystem,
  ): void {
    const ctx = this.makeContext(fs);
    activateFn(ctx);
    this._loadedManifests.push(manifest);
  }

  getComponentDef(type: string): ComponentDef | undefined {
    return this.components.get(type);
  }

  /** builtin / 直接登録用。 */
  registerComponent(def: ComponentDef): void {
    this.components.set(def.type, def);
  }

  getComponentDefs(): ComponentDef[] {
    return [...this.components.values()];
  }

  getExprHelpers(): Record<string, PureFn> {
    return Object.fromEntries(this.exprHelpers);
  }

  getEasings(): EasingPreset[] {
    return [...this.easings.values()];
  }

  get loadedManifests(): readonly PluginManifest[] {
    return this._loadedManifests;
  }

  clear(): void {
    this.components.clear();
    this.effects.clear();
    this.easings.clear();
    this.exprHelpers.clear();
    this.importers.clear();
    this.exporters.clear();
    this.inspectors.length = 0;
    this._loadedManifests.length = 0;
  }
}

/** §12 グローバルシングルトン。store がロードし、DomRenderer / ExpressionEngine が参照する。 */
export const globalPluginRegistry = new PluginRegistry();
