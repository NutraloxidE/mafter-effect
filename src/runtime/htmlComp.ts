import type { CompId, Frame, HtmlComposition, ParamDescriptor } from "../core/schema";
import type { IModuleLoader } from "./moduleLoader";

// §7 HTML Composition (Model A) — CompositionModule ライフサイクル。
// Shadow DOM で隔離し、内部 DOM が外部スタイルを汚さない（§7「隔離方式」）。
// mount(root) → render(ctx) × N → unmount?()

export interface CompositionModule {
  manifest: {
    id: string;
    resolution?: { w: number; h: number } | "inherit";
    params: ParamDescriptor[];
  };
  /** 一度だけ呼ばれる。DOM を構築する。 */
  mount(root: HTMLElement): void;
  /** 毎フレーム呼ばれる。決定論であること（INV-1）。 */
  render(ctx: CompRenderContext): void;
  unmount?(): void;
}

export interface CompRenderContext {
  root: HTMLElement;
  /** host object の inPoint を 0 とする相対 frame（§7「内部時間」）。 */
  frame: number;
  time: number; // frame / fps
  fps: number;
  width: number;
  height: number;
  /** manifest.params の keyframe/expression 解決済みの値。 */
  params: Record<string, unknown>;
}

// ─── HtmlCompEntry — オブジェクトごとのマウント状態 ─────────────────────────

interface HtmlCompEntry {
  shadowHost: HTMLDivElement;
  shadowRoot: ShadowRoot;
  module: CompositionModule;
  mounted: boolean;
  compId: CompId;
}

// ─── HtmlCompPlayer ──────────────────────────────────────────────────────────
// DomRenderer がオブジェクト div を作ったあとに呼ばれる。
// prep(compId) で CompositionModule を preload し、その後 mountObject / renderObject を呼ぶ。
//
// 使い方（エディタ側）:
//   1. player.prepare(fs, htmlComps)     // HTML comp 一覧を preload（非同期）
//   2. DomRenderer に player を渡す      // renderFrame 内で mountObject/renderObject が呼ばれる
//   3. player.dispose()                 // ページ離脱時

export class HtmlCompPlayer {
  private readonly entries = new Map<string, HtmlCompEntry>(); // objectId → entry
  private readonly modules = new Map<CompId, CompositionModule>(); // compId → module

  constructor(private readonly loader: IModuleLoader) {}

  /** HTML comp の script.js を preload する（非同期）。 */
  async prepare(
    htmlComps: HtmlComposition[],
    scriptPathOf: (compId: CompId) => string,
  ): Promise<void> {
    await Promise.all(
      htmlComps.map(async (comp) => {
        if (this.modules.has(comp.id)) return;
        const fn = await this.loader.load(scriptPathOf(comp.id));
        if (typeof fn === "function") {
          // CompositionModule は default export されたオブジェクト（関数ではない）。
          // ModuleLoader は default export を返すので、fn がオブジェクトの場合も許容する。
          const mod = fn as unknown as CompositionModule;
          if (mod && typeof mod.mount === "function") {
            this.modules.set(comp.id, mod);
          }
        }
      }),
    );
  }

  /**
   * オブジェクト div の中に Shadow DOM をマウントし、CompositionModule.mount() を呼ぶ。
   * 既にマウント済みなら何もしない。
   */
  mountObject(objectId: string, compId: CompId, hostDiv: HTMLElement): void {
    if (this.entries.has(objectId)) return;
    const mod = this.modules.get(compId);
    if (!mod) return;

    const shadowHost = document.createElement("div");
    shadowHost.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%";
    const shadowRoot = shadowHost.attachShadow({ mode: "open" });
    hostDiv.appendChild(shadowHost);

    try {
      mod.mount(shadowRoot as unknown as HTMLElement);
    } catch {
      // mount エラーはレンダリングを止めない（§9 フォールバック方針と同様）
    }

    this.entries.set(objectId, {
      shadowHost,
      shadowRoot,
      module: mod,
      mounted: true,
      compId,
    });
  }

  /** 毎フレーム: CompositionModule.render(ctx) を呼ぶ。 */
  renderObject(
    objectId: string,
    compId: CompId,
    hostFrame: Frame,
    inPoint: Frame,
    fps: number,
    comp: HtmlComposition,
    params: Record<string, unknown>,
  ): void {
    const entry = this.entries.get(objectId);
    if (!entry || entry.compId !== compId) {
      // まだマウントされていない（prepare 前など）。スキップ。
      return;
    }
    // comp 内部 frame = host frame - inPoint（§7「内部時間」）
    const relFrame = Math.max(0, Math.min(comp.duration - 1, hostFrame - inPoint));
    const ctx: CompRenderContext = {
      root: entry.shadowRoot as unknown as HTMLElement,
      frame: relFrame,
      time: relFrame / fps,
      fps,
      width: comp.width,
      height: comp.height,
      params,
    };
    try {
      entry.module.render(ctx);
    } catch {
      // render エラーはレンダリングを止めない
    }
  }

  /** オブジェクトのマウントを解除する。 */
  unmountObject(objectId: string): void {
    const entry = this.entries.get(objectId);
    if (!entry) return;
    try {
      entry.module.unmount?.();
    } catch {
      // ignore
    }
    entry.shadowHost.remove();
    this.entries.delete(objectId);
  }

  /** 全オブジェクトのマウントを解除し、キャッシュもクリアする。 */
  dispose(): void {
    for (const id of [...this.entries.keys()]) {
      this.unmountObject(id);
    }
    this.modules.clear();
  }

  hasModule(compId: CompId): boolean {
    return this.modules.has(compId);
  }
}
