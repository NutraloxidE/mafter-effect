// §12 Plugin API v1 — 型定義。
// PluginManifest は project.json の pluginRefs から参照される。

import type { ParamDescriptor } from "../core/schema";

export type PureFn = (...args: unknown[]) => unknown;

export interface PluginManifest {
  id: string;           // 逆 DNS 風識別子
  name: string;
  version: string;      // semver
  apiVersion: 1;        // host major と一致必須
  entry: string;        // plugins/<id>/ からの相対パス
  capabilities: ("component" | "effect" | "easing" | "expr" | "io" | "inspector")[];
}

export interface ComponentRenderContext {
  el: HTMLElement;
  props: Record<string, unknown>;
  frame: number;
  width: number;
  height: number;
}

export interface ComponentDef {
  type: string;
  label: string;
  /** §28 RAM Preview L2 — comp 内 baker 判定用。registry メタのみ。必須明示。 */
  previewBakeRequired: boolean;
  params: ParamDescriptor[];
  render(ctx: ComponentRenderContext): void;
  /** §11.7 web bundle export での既定。未指定なら "bake"。 */
  bundleExportDefault?: "live" | "bake";
}

// §27.2 EffectDef — resolve 済み props → フィルタ片（純関数）
export type EffectFilter =
  | { kind: "css"; fn: string }
  | { kind: "svg"; primitives: string }
  | { kind: "raster" };

export interface RasterBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface EffectRenderCtx {
  width: number;
  height: number;
  frame: number;
  /** §27.3 Dither Dissolve — ResolvedObject.opacity */
  layerOpacity?: number;
  /**
   * 実効レンダースケール（デバイス解像度 / レイヤー表示解像度、>=1）。既定 1（export/1:1）。
   * preview zoom>1 / bundle player の拡大表示で、live CSS filter が scale 後の解像度で
   * 再ラスタライズされる際、pixelStretch 等が変位マップを細分化して 1:1 化するのに使う。
   */
  renderScale?: number;
}

export interface EffectDef {
  type: string;
  label: string;
  /** Inspector エフェクト追加ピッカーでのカテゴリ見出し。未指定は「その他」。 */
  category?: string;
  /** §28 RAM Preview L2 — comp 内に enabled が1つでもあればキャッシュ優先。registry メタのみ。 */
  previewBakeRequired: boolean;
  /** §27.2 実行経路。live = backdrop/CSS filter 直適用（軽量）、raster = canvas capture（高精度）。kind と独立軸・必須明示。 */
  executionPath: "live" | "raster";
  params: ParamDescriptor[];
  bundleExportDefault?: "live" | "bake";
  apply(props: Record<string, unknown>, ctx: EffectRenderCtx): EffectFilter | null;
  /** raster effect のみ。純関数・副作用なし（INV-1）。 */
  processPixels?(input: RasterBuffer, props: Record<string, unknown>, ctx: EffectRenderCtx): RasterBuffer;
}

export interface EasingPreset {
  id: string;
  label: string;
  bezier: [number, number, number, number];
}

export interface ImporterDef {
  id: string;
  label: string;
  extensions: string[];
  import(data: ArrayBuffer): unknown;
}

export interface ExporterDef {
  id: string;
  label: string;
  export(scene: unknown): ArrayBuffer;
}

export interface InspectorControlDef {
  paramKind: string;
  render(value: unknown, onChange: (v: unknown) => void): HTMLElement;
}

/** Plugin が FS から読める読み取り専用インターフェース（§12）。 */
export interface ReadonlyFileSystem {
  readText(path: string): Promise<string>;
  list(prefix: string): Promise<string[]>;
}

/** §12 PluginContext — activate(ctx) に渡す登録 API。 */
export interface PluginContext {
  registerComponent(def: ComponentDef): void;
  registerEffect(def: EffectDef): void;
  registerEasing(preset: EasingPreset): void;
  /** 決定論必須 (INV-1)。違反する関数は呼び出し元の責任。 */
  registerExprHelper(name: string, fn: PureFn): void;
  registerImporter(def: ImporterDef): void;
  registerExporter(def: ExporterDef): void;
  registerInspector(def: InspectorControlDef): void;
  fs: ReadonlyFileSystem;
}
