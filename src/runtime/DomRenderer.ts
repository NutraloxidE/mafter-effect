import { DISPLACEMENT_EFFECT_TYPES, svgDisplaceFilterMarkup } from "./effectSvg";
import { needsSvgDisplaceCapture } from "./effectRouting";
import type { CompositionMeta, Frame, HtmlComposition, RGBA, TimelineComposition } from "../core/schema";
import type { FontOutlineCache } from "./fontOutlineCache";
import type { ImageAssetCache } from "./imageAssetCache";
import type { FrameRenderCache } from "./frameRenderCache";
import type { HtmlCompPlayer } from "./htmlComp";
import { globalPluginRegistry } from "./pluginRegistry";
import type { Renderer } from "./renderer";
import type { ResolvedComponent, ResolvedEffect, ResolvedObject, ResolvedScene } from "./resolved";
import { compChildFrame, isCompNestDepthAllowed } from "./compLayer";
import type { NestedCompRasterizer } from "./compFrameCapture";
import { resolve } from "./resolve";
import { applyTextEl, rgbaCss } from "./textRender";
import { captureElementToCanvas, rasterizeFilteredImage } from "./rasterCapture";
import { canvasToRasterBuffer, rasterBufferToCanvas } from "./pixelSort";
import { processRasterChainAsync } from "./rasterProcessAsync";
import type { EffectFilter } from "./plugin";

// §8 DomRenderer — フラット matrix3d レンダラ。
// 各 ResolvedObject を root の兄弟 div として並べる。ネストしない。
// transform-origin:0 0（anchor は行列に内包済み, §6.3）。
// opacity は per-object（CSS opacity は子へ合成される stacking context を作るため、
// 兄弟フラット配置で回避, §5.4-note）。
//
// background は CompositionMeta（mount で受け取る, §8 シグネチャ）から取る。
// ResolvedScene には載せない（INV-3: レンダラは ResolvedScene のみ受け取るが、静的 comp メタは mount 経由）。
//
// 子要素はフレーム毎に innerHTML で破棄せず **reconcile** する（<img> の再読み込み flicker 回避）。
// component の型シグネチャが変わったときだけ作り直す。

const BASE_Z = 10; // z-index はこの値を起点に zOrder*BASE_Z で割り当てる

interface ObjectEntry {
  div: HTMLDivElement;
  childSig: string; // component 型の連結。変化したら子を作り直す
  fxSig: string; // effect 型/順序/有効状態/props。変化したら svg defs を作り直す
  children: HTMLElement[];
  svgRoot: SVGSVGElement | null;
  rasterCanvas: HTMLCanvasElement | null;
  contentHidden: boolean;
  rasterRunKey: string;
  rasterInFlightKey: string | null;
  rasterCompletedKey: string | null;
  /** 調整レイヤー raster 合成時に背面へ隠したレイヤーを指す adjustment object id */
  suppressedForAdjustment: string | null;
  /** §27.3 displacement filter region 用（applyEffects で設定） */
  fxLayerW: number;
  fxLayerH: number;
  fxMaxDisplaceScale: number;
  /** adjustment + displacement → backdrop-filter 経路 */
  fxUseBackdropDisplace: boolean;
}

interface RasterWorkItem {
  effect: ResolvedEffect;
  def: NonNullable<ReturnType<typeof globalPluginRegistry.getEffectDef>>;
}

export class DomRenderer implements Renderer {
  readonly kind = "dom" as const;

  private root: HTMLDivElement | null = null;
  private entries = new Map<string, ObjectEntry>();
  private currentComp: CompositionMeta | null = null;
  private rasterPending = new Set<Promise<void>>();

  // §7 HTML comp サポート: HtmlCompPlayer を注入（optional）。
  // mount 後に setHtmlPlayer() で差し替え可。
  private htmlPlayer: HtmlCompPlayer | null = null;

  // §26.4 テキスト品質モード
  private textQuality: "draft" | "precise" = "precise";
  private fontCache: FontOutlineCache | null = null;
  private imageCache: ImageAssetCache | null = null;
  private frameRenderCache: FrameRenderCache | null = null;
  /** §28.11 ネスト comp の comp 単位ラスタライザ（注入式・optional） */
  private nestedCompRasterizer: NestedCompRasterizer | null = null;
  /** 現フレームに adjustment + displacement がある（下位 overflow 方針用） */
  private compHasAdjustmentDisplace = false;
  /** §27.12 hold-last raster（full displacement 用）。 */
  private holdLastRaster = false;
  /** §27.4 auto_raster_mp4 — mp4/png export 時に Live調整も comp 背面 capture へ回す
   *  （backdrop-filter は foreignObject ラスタ化で消えるため）。web bundle/preview では false。 */
  private forceAdjustmentRaster = false;

  setPreviewRenderOptions(opts: {
    holdLastRaster?: boolean;
    forceAdjustmentRaster?: boolean;
  }): void {
    if (opts.holdLastRaster !== undefined) this.holdLastRaster = opts.holdLastRaster;
    if (opts.forceAdjustmentRaster !== undefined) this.forceAdjustmentRaster = opts.forceAdjustmentRaster;
  }

  setTextQuality(mode: "draft" | "precise"): void {
    this.textQuality = mode;
  }

  setFontCache(cache: FontOutlineCache | null): void {
    this.fontCache = cache;
  }

  setImageCache(cache: ImageAssetCache | null): void {
    this.imageCache = cache;
  }

  setFrameRenderCache(cache: FrameRenderCache | null): void {
    this.frameRenderCache = cache;
  }

  /** §28.11 — ラスター化対象のネスト comp を comp 単位画像で描く rasterizer を注入。 */
  setNestedCompRasterizer(rasterizer: NestedCompRasterizer | null): void {
    this.nestedCompRasterizer = rasterizer;
  }

  setHtmlPlayer(player: HtmlCompPlayer | null): void {
    this.htmlPlayer = player;
  }

  mount(container: HTMLElement, comp: CompositionMeta): void {
    this.dispose();
    const root = document.createElement("div");
    root.style.cssText = [
      "position:relative",
      "overflow:hidden",
      "transform-style:preserve-3d",
      "width:100%",
      "height:100%",
      "isolation:isolate",
    ].join(";");
    if (comp.background) root.style.background = rgbaCss(comp.background);
    container.appendChild(root);
    this.root = root;
    this.currentComp = comp;
  }

  renderFrame(scene: ResolvedScene, frame: Frame): void {
    if (!this.root) return;

    this.compHasAdjustmentDisplace = scene.objects.some(
      (o) =>
        o.isAdjustment === true &&
        (o.effects ?? []).some((e) => e.enabled && DISPLACEMENT_EFFECT_TYPES.has(e.type)),
    );

    // camera / perspective (§6.5)
    if (scene.camera) {
      const perspective = scene.height / 2 / Math.tan((scene.camera.fov * Math.PI) / 360);
      this.root.style.perspective = `${perspective}px`;
      this.root.style.perspectiveOrigin = "50% 50%";
      this.root.style.transform = mat4ToCss(scene.camera.viewMatrix);
    } else {
      this.root.style.perspective = "";
      this.root.style.transform = "";
    }

    const seen = new Set<string>();
    for (const obj of scene.objects) {
      if (obj.isNull) continue;
      seen.add(obj.id);
      let entry = this.entries.get(obj.id);
      if (!entry) {
        const div = document.createElement("div");
        div.style.position = "absolute";
        div.style.top = "0";
        div.style.left = "0";
        div.style.transformOrigin = "0 0";
        div.dataset.objectId = obj.id;
        this.root.appendChild(div);
        entry = {
          div,
          childSig: "",
          fxSig: "",
          children: [],
          svgRoot: null,
          rasterCanvas: null,
          contentHidden: false,
          rasterRunKey: "",
          rasterInFlightKey: null,
          rasterCompletedKey: null,
          suppressedForAdjustment: null,
          fxLayerW: 0,
          fxLayerH: 0,
          fxMaxDisplaceScale: 0,
          fxUseBackdropDisplace: false,
        };
        this.entries.set(obj.id, entry);
      }
      this.applyObject(entry, obj, frame);
    }

    // 非表示になったオブジェクトを削除
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        this.restoreAdjustmentSuppression(id);
        entry.div.remove();
        this.entries.delete(id);
        this.htmlPlayer?.unmountObject(id);
      }
    }
  }

  resize(w: number, h: number): void {
    if (!this.root) return;
    this.root.style.width = `${w}px`;
    this.root.style.height = `${h}px`;
  }

  /** §11.2 export 用: マウントした root 要素を返す。 */
  getRoot(): HTMLElement | null {
    return this.root;
  }

  /** §27.1 raster — 非同期 raster effect 完了を待つ（export 用・INV-2）。 */
  async flushRasterEffects(): Promise<void> {
    if (this.rasterPending.size === 0) return;
    await Promise.all([...this.rasterPending]);
  }

  dispose(): void {
    if (this.root) {
      this.root.remove();
      this.root = null;
    }
    this.entries.clear();
    this.currentComp = null;
  }

  private applyObject(entry: ObjectEntry, obj: ResolvedObject, frame: Frame): void {
    entry.div.style.transform = mat4ToCss(obj.worldTransform);
    entry.div.style.opacity = String(obj.opacity);
    entry.div.style.zIndex = String(Math.round(obj.zOrder * BASE_Z));

    if (obj.isAdjustment) {
      const w = this.currentComp?.width ?? 0;
      const h = this.currentComp?.height ?? 0;
      entry.div.style.width = `${w}px`;
      entry.div.style.height = `${h}px`;
      entry.div.style.background = "transparent";
      entry.div.style.pointerEvents = "none";
    } else {
      entry.div.style.width = "";
      entry.div.style.height = "";
      entry.div.style.background = "";
    }

    const sig = obj.components.map((c) => c.type).join("|");
    if (sig !== entry.childSig) {
      // html comp が含まれていた場合は player のエントリも解放してから作り直す
      if (entry.childSig.split("|").includes("html")) {
        this.htmlPlayer?.unmountObject(obj.id);
      }
      // 構造が変わった: 子を作り直す（svgRoot は残す）
      const svgRoot = entry.svgRoot;
      entry.div.innerHTML = "";
      if (svgRoot) entry.div.appendChild(svgRoot);
      entry.children = obj.components.map((c) => {
        const el = createComponentEl(c.type);
        entry.div.appendChild(el);
        return el;
      });
      entry.childSig = sig;
    }

    // props を in-place で更新（<img> src は変化時のみ → 再読込しない）
    obj.components.forEach((c, i) => {
      const el = entry.children[i];
      if (el) {
        const hostInPoint = (c.props["_hostInPoint"] as number | undefined) ?? 0;
        updateComponentEl(el, c.type, c.props, this.textQuality, this.fontCache, this.imageCache, frame, hostInPoint, this.currentComp?.fps ?? 30);
      }

      // Plugin component: registry から ComponentDef.render を呼ぶ（組み込み型は未登録でスキップ）
      if (el) {
        const pluginDef = globalPluginRegistry.getComponentDef(c.type);
        if (pluginDef) {
          pluginDef.render({
            el,
            props: c.props as Record<string, unknown>,
            frame,
            width: this.currentComp?.width ?? 0,
            height: this.currentComp?.height ?? 0,
          });
        }
      }

      // §23 comp: 子 timeline comp をコンテナ div にネスト描画
      if (c.type === "comp" && el) {
        const compId = (c.props["compId"] as string | undefined) ?? "";
        const childComp = this.pendingTimelineComps?.get(compId);
        if (childComp) {
          const inPoint = (c.props["_inPoint"] as number) ?? 0;
          const trimStart = (c.props["trimStart"] as number) ?? 0;
          const childFrame = compChildFrame(frame, inPoint, trimStart, childComp.duration);
          this.renderNestedComp(el, childComp, childFrame, 1);
        }
      }

      // html comp: HtmlCompPlayer に mount/render を委譲
      if (c.type === "html" && this.htmlPlayer && el) {
        const compId = (c.props["compId"] as string | undefined) ?? "";
        if (compId) {
          // HtmlComposition を currentComp から探す（timeline comp 内の html component 用）
          // currentComp は TimelineComposition。html comp meta は Project から別途渡される。
          // ここでは player.mountObject / renderObject を呼ぶのみ。
          // inPoint は ResolvedObject には含まれないため props から取る（fallback=0）。
          const inPoint = (c.props["inPoint"] as number | undefined) ?? 0;
          const fps = (this.currentComp?.fps) ?? 30;
          const htmlComp: HtmlComposition | null =
            this.pendingHtmlComps?.get(compId) ?? null;
          if (htmlComp) {
            // host div に comp 寸法を与える（Shadow DOM は 100% で追従する）。
            el.style.width = `${htmlComp.width}px`;
            el.style.height = `${htmlComp.height}px`;
            this.htmlPlayer.mountObject(obj.id, compId, el);
            this.htmlPlayer.renderObject(
              obj.id,
              compId,
              frame,
              inPoint,
              fps,
              htmlComp,
              c.props as Record<string, unknown>,
            );
          }
        }
      }
    });

    // effects は子要素のサイズ確定後に適用する（マスク/displacement map を
    // レイヤーの実寸に合わせるため offsetWidth/Height を測る・§27.1）。
    this.applyEffects(entry, obj, frame);
  }

  /** §27.1/§27.4 — effects を filter / backdrop-filter / raster として適用。 */
  private applyEffects(entry: ObjectEntry, obj: ResolvedObject, frame: Frame): void {
    const effects = obj.effects ?? [];
    const fxSig = effects
      .map((e) => `${e.type}:${e.enabled ? 1 : 0}:${JSON.stringify(e.props)}`)
      .join("|");
    const compW = this.currentComp?.width ?? 0;
    const compH = this.currentComp?.height ?? 0;
    let layerW = 0;
    let layerH = 0;
    for (const child of entry.children) {
      layerW = Math.max(layerW, child.offsetWidth);
      layerH = Math.max(layerH, child.offsetHeight);
    }
    const ctx = obj.isAdjustment
      ? { width: compW, height: compH, frame }
      : {
          width: layerW || entry.div.offsetWidth || compW,
          height: layerH || entry.div.offsetHeight || compH,
          frame,
        };

    let fxMaxDisplaceScale = 0;
    let hasDisplacementFx = false;
    for (const effect of effects) {
      if (!effect.enabled) continue;
      if (!DISPLACEMENT_EFFECT_TYPES.has(effect.type)) continue;
      hasDisplacementFx = true;
      const p = effect.props;
      const scale =
        effect.type === "wave" ||
        effect.type === "ripple" ||
        effect.type === "fastWave" ||
        effect.type === "fastRipple"
          ? Math.max(0, typeof p["amplitude"] === "number" ? p["amplitude"] : 0)
          : Math.max(0, typeof p["amount"] === "number" ? p["amount"] : 0);
      fxMaxDisplaceScale = Math.max(fxMaxDisplaceScale, scale);
    }
    entry.fxLayerW = Math.max(1, Math.round(ctx.width));
    entry.fxLayerH = Math.max(1, Math.round(ctx.height));
    entry.fxMaxDisplaceScale = fxMaxDisplaceScale;
    entry.fxUseBackdropDisplace = obj.isAdjustment === true && hasDisplacementFx;

    if (hasDisplacementFx && !obj.isAdjustment) {
      entry.div.style.width = `${entry.fxLayerW}px`;
      entry.div.style.height = `${entry.fxLayerH}px`;
      entry.div.style.overflow = this.compHasAdjustmentDisplace ? "hidden" : "visible";
    } else if (!obj.isAdjustment) {
      entry.div.style.overflow = "";
    }

    if (fxSig !== entry.fxSig) {
      if (entry.svgRoot) {
        entry.svgRoot.remove();
        entry.svgRoot = null;
      }
      entry.fxSig = fxSig;
      entry.rasterCompletedKey = null;
      entry.rasterInFlightKey = null;
    }

    const preTokens: string[] = [];
    const postTokens: string[] = [];
    const preSvgFilters: { id: string; primitives: string }[] = [];
    const postSvgFilters: { id: string; primitives: string }[] = [];
    const rasterChain: RasterWorkItem[] = [];
    let inRasterSection = false;
    let preSvgIndex = 0;
    let postSvgIndex = 0;

    for (const effect of effects) {
      if (!effect.enabled) continue;
      const def = globalPluginRegistry.getEffectDef(effect.type);
      if (!def) continue;
      const piece = def.apply(effect.props, ctx);
      if (!piece) continue;

      if (piece.kind === "raster") {
        inRasterSection = true;
        rasterChain.push({ effect, def });
      } else if (inRasterSection) {
        this.pushFilterPiece(piece, postTokens, postSvgFilters, `fx-${obj.id}-post-${postSvgIndex++}`);
      } else {
        this.pushFilterPiece(piece, preTokens, preSvgFilters, `fx-${obj.id}-pre-${preSvgIndex++}`);
      }
    }

    if (rasterChain.length === 0) {
      const allTokens = [...preTokens, ...postTokens];
      const allSvgFilters = [...preSvgFilters, ...postSvgFilters];
      // §27.4: Raster調整は live effect（blur/tint/wipe）も backdrop-filter ではなく
      // comp 背面 capture で焼く。export（forceAdjustmentRaster）では Live調整も同様に raster 化
      // （auto_raster_mp4）。通常レイヤーは従来どおり（displacement のみ capture）。
      const needsCapture = needsSvgDisplaceCapture({
        isAdjustment: obj.isAdjustment,
        adjustmentMode: obj.adjustmentMode,
        forceAdjustmentRaster: this.forceAdjustmentRaster,
        effects: obj.effects,
        hasLiveFilterTokens: allTokens.length > 0,
      });
      if (needsCapture) {
        const filterStr = allTokens.join(" ");
        const rasterRunKey = `${fxSig}|f${frame}`;
        entry.rasterRunKey = rasterRunKey;
        if (entry.rasterCompletedKey === rasterRunKey && entry.rasterCanvas) {
          this.finalizeRasterPresentation(entry, obj, "", []);
          return;
        }
        if (entry.rasterInFlightKey === rasterRunKey) {
          return;
        }
        const work = obj.isAdjustment
          ? this.runAdjustmentSvgDisplacePipeline(entry, obj, ctx, filterStr, allSvgFilters, rasterRunKey)
          : this.runDirectSvgDisplacePipeline(entry, obj, ctx, filterStr, allSvgFilters, rasterRunKey);
        const tracked = work.finally(() => {
          this.rasterPending.delete(tracked);
        });
        this.rasterPending.add(tracked);
        return;
      }
      this.clearRasterOverlay(entry);
      if (obj.isAdjustment) this.restoreAdjustmentSuppression(obj.id);
      this.applyFilterTokens(entry, obj, allTokens, allSvgFilters);
      return;
    }

    this.applyFilterTokens(entry, obj, preTokens, preSvgFilters);
    const postFilterStr = postTokens.join(" ");
    const rasterRunKey = `${fxSig}|f${frame}`;
    entry.rasterRunKey = rasterRunKey;

    if (entry.rasterCompletedKey === rasterRunKey && entry.rasterCanvas) {
      this.finalizeRasterPresentation(entry, obj, postFilterStr, postSvgFilters);
      return;
    }
    if (entry.rasterInFlightKey === rasterRunKey) {
      return;
    }

    const work = obj.isAdjustment
      ? this.runAdjustmentRasterPipeline(entry, obj, ctx, rasterChain, postFilterStr, postSvgFilters, rasterRunKey)
      : this.runRasterPipeline(entry, obj, ctx, rasterChain, postFilterStr, postSvgFilters, rasterRunKey);
    const tracked = work.finally(() => {
      this.rasterPending.delete(tracked);
    });
    this.rasterPending.add(tracked);
  }

  private pushFilterPiece(
    piece: EffectFilter,
    tokens: string[],
    svgFilters: { id: string; primitives: string }[],
    id: string,
  ): void {
    if (piece.kind === "css") {
      tokens.push(piece.fn);
    } else if (piece.kind === "svg") {
      svgFilters.push({ id, primitives: piece.primitives });
      tokens.push(`url(#${id})`);
    }
  }

  private applyFilterTokens(
    entry: ObjectEntry,
    obj: ResolvedObject,
    tokens: string[],
    svgFilters: { id: string; primitives: string }[],
  ): void {
    const filterStr = tokens.join(" ");
    if (obj.isAdjustment) {
      entry.div.style.filter = "";
      entry.div.style.backdropFilter = filterStr;
      (entry.div.style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter = filterStr;
    } else {
      entry.div.style.backdropFilter = "";
      (entry.div.style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter = "";
      entry.div.style.filter = filterStr;
    }
    this.syncSvgFilters(entry, svgFilters);
  }

  private syncSvgFilters(
    entry: ObjectEntry,
    svgFilters: { id: string; primitives: string }[],
  ): void {
    if (svgFilters.length > 0) {
      if (!entry.svgRoot) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("aria-hidden", "true");
        svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
        entry.div.insertBefore(svg, entry.div.firstChild);
        entry.svgRoot = svg;
      }
      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      for (const { id, primitives } of svgFilters) {
        defs.appendChild(this.createSvgFilterElement(id, primitives, entry));
      }
      entry.svgRoot.innerHTML = "";
      entry.svgRoot.appendChild(defs);
    } else if (entry.svgRoot) {
      entry.svgRoot.remove();
      entry.svgRoot = null;
    }
  }

  private createSvgFilterElement(
    id: string,
    primitives: string,
    entry: Pick<ObjectEntry, "fxLayerW" | "fxLayerH" | "fxMaxDisplaceScale" | "fxUseBackdropDisplace">,
  ): SVGFilterElement {
    const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.setAttribute("id", id);
    filter.setAttribute("color-interpolation-filters", "sRGB");
    const isDisplace = primitives.includes("feDisplacementMap");
    if (isDisplace && entry.fxLayerW > 0 && entry.fxLayerH > 0) {
      // §27.12 改定3: filter region は layer bounds (0,0,w,h) にクランプ（pad しない）。
      // pad すると feImage map 未定義域（channel≈0）で定数変位が発生し素矩形が露出する。
      // クランプで live CSS filter は raster（W×H クリップ）と pixel parity になる。
      filter.setAttribute("filterUnits", "userSpaceOnUse");
      filter.setAttribute("primitiveUnits", "userSpaceOnUse");
      filter.setAttribute("x", "0");
      filter.setAttribute("y", "0");
      filter.setAttribute("width", String(entry.fxLayerW));
      filter.setAttribute("height", String(entry.fxLayerH));
    } else {
      filter.setAttribute("x", "-25%");
      filter.setAttribute("y", "-25%");
      filter.setAttribute("width", "150%");
      filter.setAttribute("height", "150%");
    }
    filter.innerHTML = primitives;
    return filter;
  }

  /** 通常レイヤー + SVG displacement — 子コンテンツをキャプチャし SVG filter 適用（CSS filter ドリフト回避）。 */
  private async runDirectSvgDisplacePipeline(
    entry: ObjectEntry,
    obj: ResolvedObject,
    ctx: { width: number; height: number; frame: number },
    filterStr: string,
    svgFilters: { id: string; primitives: string }[],
    rasterRunKey: string,
  ): Promise<void> {
    if (!filterStr) return;
    const w = Math.max(1, Math.round(ctx.width));
    const h = Math.max(1, Math.round(ctx.height));
    if (w === 0 || h === 0) return;

    entry.rasterInFlightKey = rasterRunKey;
    if (!this.holdLastRaster) {
      entry.div.style.filter = "";
      entry.div.style.backdropFilter = "";
      (entry.div.style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter = "";
    }

    try {
      const propsHash = entry.fxSig;
      // §28.10: layer-local frame をキーにすることで、レイヤーのスライド（move）で
      // comp フレームがずれても内容不変なら再ラスタせず再利用する。
      const cacheKey = { objectId: obj.id, frame: Math.max(0, ctx.frame - obj.inPoint), propsHash };
      const cached = await this.frameRenderCache?.get(cacheKey);
      if (cached?.data) {
        this.presentRasterCanvas(entry, cached.data, w, h);
        entry.rasterCompletedKey = rasterRunKey;
        this.finalizeRasterPresentation(entry, obj, "", []);
        return;
      }

      const captureEl = document.createElement("div");
      captureEl.style.cssText = `position:relative;width:${w}px;height:${h}px;overflow:hidden;`;
      for (const child of entry.children) {
        const clone = child.cloneNode(true) as HTMLElement;
        clone.style.visibility = "visible";
        captureEl.appendChild(clone);
      }

      const canvas = await captureElementToCanvas(captureEl, w, h, "transparent");
      let buffer = canvasToRasterBuffer(canvas);
      const filterEntry: Pick<ObjectEntry, "fxLayerW" | "fxLayerH" | "fxMaxDisplaceScale" | "fxUseBackdropDisplace"> = {
        fxLayerW: w,
        fxLayerH: h,
        fxMaxDisplaceScale: entry.fxMaxDisplaceScale,
        fxUseBackdropDisplace: false,
      };
      buffer = await this.applyCssSvgFilterToBuffer(buffer, w, h, filterStr, svgFilters, filterEntry);

      if (entry.rasterRunKey !== rasterRunKey) return;
      if (!this.bufferHasVisiblePixels(buffer)) {
        throw new Error("direct svg displace capture empty");
      }

      this.presentRasterCanvas(entry, buffer, w, h);
      entry.rasterCompletedKey = rasterRunKey;
      void this.frameRenderCache?.put(cacheKey, { data: buffer });
      this.finalizeRasterPresentation(entry, obj, "", []);
    } catch {
      if (entry.rasterCompletedKey !== rasterRunKey) {
        this.clearRasterOverlay(entry);
      }
    } finally {
      if (entry.rasterInFlightKey === rasterRunKey) entry.rasterInFlightKey = null;
    }
  }

  /** 調整レイヤー + SVG displacement — backdrop ではなく comp キャプチャ + filter で適用（ドリフト低減）。 */
  private async runAdjustmentSvgDisplacePipeline(
    entry: ObjectEntry,
    obj: ResolvedObject,
    ctx: { width: number; height: number; frame: number },
    filterStr: string,
    svgFilters: { id: string; primitives: string }[],
    rasterRunKey: string,
  ): Promise<void> {
    if (!this.root || !filterStr) return;
    const w = Math.max(1, Math.round(ctx.width));
    const h = Math.max(1, Math.round(ctx.height));
    const adjustZ = Math.round(obj.zOrder * BASE_Z);

    entry.rasterInFlightKey = rasterRunKey;
    if (!this.holdLastRaster) {
      entry.div.style.filter = "";
      entry.div.style.backdropFilter = "";
      (entry.div.style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter = "";
    }

    const hiddenForCapture: HTMLElement[] = [];
    const restoreCaptureVisibility = (): void => {
      for (const div of hiddenForCapture) div.style.visibility = "";
    };

    for (const [id, other] of this.entries) {
      const z = parseInt(other.div.style.zIndex, 10);
      if (id !== obj.id && z < adjustZ) {
        other.div.style.visibility = "visible";
      }
    }
    for (const [id, other] of this.entries) {
      const z = parseInt(other.div.style.zIndex, 10);
      if (id === obj.id || z <= adjustZ) continue;
      hiddenForCapture.push(other.div);
      other.div.style.visibility = "hidden";
    }
    hiddenForCapture.push(entry.div);
    entry.div.style.visibility = "hidden";

    try {
      const propsHash = entry.fxSig;
      // §28.10: layer-local frame をキーにすることで、レイヤーのスライド（move）で
      // comp フレームがずれても内容不変なら再ラスタせず再利用する。
      const cacheKey = { objectId: obj.id, frame: Math.max(0, ctx.frame - obj.inPoint), propsHash };
      const cached = await this.frameRenderCache?.get(cacheKey);
      if (cached?.data) {
        restoreCaptureVisibility();
        this.presentRasterCanvas(entry, cached.data, w, h);
        entry.rasterCompletedKey = rasterRunKey;
        this.finalizeRasterPresentation(entry, obj, "", []);
        return;
      }

      const canvas = await captureElementToCanvas(this.root, w, h, "transparent");
      restoreCaptureVisibility();

      let buffer = canvasToRasterBuffer(canvas);
      const filterEntry: Pick<ObjectEntry, "fxLayerW" | "fxLayerH" | "fxMaxDisplaceScale" | "fxUseBackdropDisplace"> = {
        fxLayerW: w,
        fxLayerH: h,
        fxMaxDisplaceScale: entry.fxMaxDisplaceScale,
        fxUseBackdropDisplace: false,
      };
      buffer = await this.applyCssSvgFilterToBuffer(buffer, w, h, filterStr, svgFilters, filterEntry);

      if (entry.rasterRunKey !== rasterRunKey) return;
      if (!this.bufferHasVisiblePixels(buffer)) {
        throw new Error("adjustment svg displace capture empty");
      }

      this.presentRasterCanvas(entry, buffer, w, h);
      entry.rasterCompletedKey = rasterRunKey;
      void this.frameRenderCache?.put(cacheKey, { data: buffer });
      this.finalizeRasterPresentation(entry, obj, "", []);
    } catch {
      restoreCaptureVisibility();
      if (entry.rasterCompletedKey === rasterRunKey && entry.rasterCanvas) {
        this.reapplyAdjustmentSuppression(obj.id, adjustZ);
      } else if (entry.rasterCompletedKey !== rasterRunKey) {
        this.clearRasterOverlay(entry);
        this.restoreAdjustmentSuppression(obj.id);
      }
    } finally {
      if (entry.rasterInFlightKey === rasterRunKey) entry.rasterInFlightKey = null;
    }
  }

  private async applyCssSvgFilterToBuffer(
    buffer: { data: Uint8ClampedArray; width: number; height: number },
    w: number,
    h: number,
    filterStr: string,
    svgFilters: { id: string; primitives: string }[],
    filterEntry: Pick<ObjectEntry, "fxLayerW" | "fxLayerH" | "fxMaxDisplaceScale" | "fxUseBackdropDisplace">,
  ): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
    const sourceCanvas = rasterBufferToCanvas(buffer);
    const dataUrl = sourceCanvas.toDataURL("image/png");
    const filtersMarkup = svgFilters
      .map(({ id, primitives }) => {
        const isDisplace = primitives.includes("feDisplacementMap");
        if (isDisplace && filterEntry.fxLayerW > 0 && filterEntry.fxLayerH > 0) {
          return svgDisplaceFilterMarkup(
            id,
            primitives,
            filterEntry.fxLayerW,
            filterEntry.fxLayerH,
            filterEntry.fxMaxDisplaceScale,
            filterEntry.fxUseBackdropDisplace,
          );
        }
        return `<filter id="${id}" color-interpolation-filters="sRGB" x="-25%" y="-25%" width="150%" height="150%">${primitives}</filter>`;
      })
      .join("");
    // filterStr は CSS token（blur 等）と url(#svg) 参照を順序通り含む完全 chain。
    // url(#svg) は filtersMarkup の SVG <filter> を参照する。
    const out = await rasterizeFilteredImage(dataUrl, w, h, filtersMarkup, filterStr);
    return canvasToRasterBuffer(out);
  }

  private reapplyAdjustmentSuppression(adjustmentId: string, adjustZ: number): void {
    for (const [id, other] of this.entries) {
      if (id === adjustmentId) continue;
      const z = parseInt(other.div.style.zIndex, 10);
      if (z < adjustZ) {
        other.div.style.visibility = "hidden";
        other.suppressedForAdjustment = adjustmentId;
      }
    }
  }

  /** raster 完了後の表示状態（canvas 表示・下位レイヤー抑制・post filter）。 */
  private finalizeRasterPresentation(
    entry: ObjectEntry,
    obj: ResolvedObject,
    postFilterStr: string,
    postSvgFilters: { id: string; primitives: string }[],
  ): void {
    if (obj.isAdjustment) {
      this.restoreAdjustmentSuppression(obj.id);
      this.reapplyAdjustmentSuppression(obj.id, Math.round(obj.zOrder * BASE_Z));
    } else if (!entry.contentHidden) {
      for (const child of entry.children) {
        child.style.visibility = "hidden";
      }
      entry.contentHidden = true;
    }
    entry.div.style.filter = postFilterStr;
    this.syncSvgFilters(entry, postSvgFilters);
  }

  private restoreAdjustmentSuppression(adjustmentId: string): void {
    for (const [, other] of this.entries) {
      if (other.suppressedForAdjustment === adjustmentId) {
        other.div.style.visibility = "";
        other.suppressedForAdjustment = null;
      }
    }
  }

  private presentRasterCanvas(
    entry: ObjectEntry,
    buffer: { data: Uint8ClampedArray; width: number; height: number },
    w: number,
    h: number,
  ): void {
    if (!entry.rasterCanvas) {
      entry.rasterCanvas = rasterBufferToCanvas(buffer);
      entry.rasterCanvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
      entry.div.appendChild(entry.rasterCanvas);
    } else {
      entry.rasterCanvas.width = w;
      entry.rasterCanvas.height = h;
      const ctx2d = entry.rasterCanvas.getContext("2d");
      if (ctx2d) {
        ctx2d.putImageData(new ImageData(new Uint8ClampedArray(buffer.data), w, h), 0, 0);
      }
    }
  }

  private bufferHasVisiblePixels(buffer: { data: Uint8ClampedArray; width: number; height: number }): boolean {
    const { data } = buffer;
    for (let i = 3; i < data.length; i += 16) {
      if (data[i]! > 0 && (data[i - 3]! > 0 || data[i - 2]! > 0 || data[i - 1]! > 0)) return true;
    }
    return false;
  }

  private clearRasterOverlay(entry: ObjectEntry): void {
    if (entry.rasterCanvas) {
      entry.rasterCanvas.remove();
      entry.rasterCanvas = null;
    }
    if (entry.contentHidden) {
      for (const child of entry.children) {
        child.style.visibility = "";
      }
      entry.contentHidden = false;
    }
    entry.rasterCompletedKey = null;
    entry.rasterInFlightKey = null;
  }

  private async runRasterPipeline(
    entry: ObjectEntry,
    obj: ResolvedObject,
    ctx: { width: number; height: number; frame: number },
    rasterChain: RasterWorkItem[],
    postFilterStr: string,
    postSvgFilters: { id: string; primitives: string }[],
    rasterRunKey: string,
  ): Promise<void> {
    const w = Math.max(1, Math.round(ctx.width));
    const h = Math.max(1, Math.round(ctx.height));
    if (w === 0 || h === 0) return;

    entry.rasterInFlightKey = rasterRunKey;
    try {
      const propsHash = entry.fxSig;
      // §28.10: layer-local frame をキーにすることで、レイヤーのスライド（move）で
      // comp フレームがずれても内容不変なら再ラスタせず再利用する。
      const cacheKey = { objectId: obj.id, frame: Math.max(0, ctx.frame - obj.inPoint), propsHash };
      const cached = await this.frameRenderCache?.get(cacheKey);
      if (cached?.data) {
        this.presentRasterCanvas(entry, cached.data, w, h);
        entry.rasterCompletedKey = rasterRunKey;
        this.finalizeRasterPresentation(entry, obj, postFilterStr, postSvgFilters);
        return;
      }

      const captureEl = document.createElement("div");
      captureEl.style.cssText = `position:relative;width:${w}px;height:${h}px;overflow:hidden;`;
      captureEl.style.filter = entry.div.style.filter;
      for (const child of entry.children) {
        const clone = child.cloneNode(true) as HTMLElement;
        clone.style.visibility = "visible";
        captureEl.appendChild(clone);
      }
      if (entry.svgRoot) {
        captureEl.insertBefore(entry.svgRoot.cloneNode(true), captureEl.firstChild);
      }

      const canvas = await captureElementToCanvas(captureEl, w, h, "transparent");
      let buffer = canvasToRasterBuffer(canvas);

      buffer = await processRasterChainAsync(buffer, rasterChain, ctx);

      if (entry.rasterRunKey !== rasterRunKey) return;
      if (!this.bufferHasVisiblePixels(buffer)) {
        throw new Error("raster capture empty");
      }

      this.presentRasterCanvas(entry, buffer, w, h);
      entry.rasterCompletedKey = rasterRunKey;
      void this.frameRenderCache?.put(cacheKey, { data: buffer });
      this.finalizeRasterPresentation(entry, obj, postFilterStr, postSvgFilters);
    } catch {
      if (entry.rasterCompletedKey !== rasterRunKey) {
        this.clearRasterOverlay(entry);
      }
    } finally {
      if (entry.rasterInFlightKey === rasterRunKey) entry.rasterInFlightKey = null;
    }
  }

  /** §27.4 調整レイヤー — 背面合成を comp 解像度で raster 化して buffer→buffer を適用。 */
  private async runAdjustmentRasterPipeline(
    entry: ObjectEntry,
    obj: ResolvedObject,
    ctx: { width: number; height: number; frame: number },
    rasterChain: RasterWorkItem[],
    postFilterStr: string,
    postSvgFilters: { id: string; primitives: string }[],
    rasterRunKey: string,
  ): Promise<void> {
    if (!this.root) return;
    const w = Math.max(1, Math.round(ctx.width));
    const h = Math.max(1, Math.round(ctx.height));
    const adjustZ = Math.round(obj.zOrder * BASE_Z);

    entry.rasterInFlightKey = rasterRunKey;
    const hiddenForCapture: HTMLElement[] = [];
    const restoreCaptureVisibility = (): void => {
      for (const div of hiddenForCapture) div.style.visibility = "";
    };

    for (const [id, other] of this.entries) {
      const z = parseInt(other.div.style.zIndex, 10);
      if (id !== obj.id && z < adjustZ) {
        other.div.style.visibility = "visible";
      }
    }

    for (const [id, other] of this.entries) {
      const z = parseInt(other.div.style.zIndex, 10);
      if (id === obj.id || z <= adjustZ) continue;
      hiddenForCapture.push(other.div);
      other.div.style.visibility = "hidden";
    }
    hiddenForCapture.push(entry.div);
    entry.div.style.visibility = "hidden";

    try {
      const propsHash = entry.fxSig;
      // §28.10: layer-local frame をキーにすることで、レイヤーのスライド（move）で
      // comp フレームがずれても内容不変なら再ラスタせず再利用する。
      const cacheKey = { objectId: obj.id, frame: Math.max(0, ctx.frame - obj.inPoint), propsHash };
      const cached = await this.frameRenderCache?.get(cacheKey);
      if (cached?.data) {
        restoreCaptureVisibility();
        this.presentRasterCanvas(entry, cached.data, w, h);
        entry.rasterCompletedKey = rasterRunKey;
        this.finalizeRasterPresentation(entry, obj, postFilterStr, postSvgFilters);
        return;
      }

      const canvas = await captureElementToCanvas(this.root, w, h, "transparent");
      restoreCaptureVisibility();

      let buffer = canvasToRasterBuffer(canvas);
      buffer = await processRasterChainAsync(buffer, rasterChain, ctx);

      if (entry.rasterRunKey !== rasterRunKey) return;
      if (!this.bufferHasVisiblePixels(buffer)) {
        throw new Error("adjustment raster capture empty");
      }

      this.presentRasterCanvas(entry, buffer, w, h);
      entry.rasterCompletedKey = rasterRunKey;
      void this.frameRenderCache?.put(cacheKey, { data: buffer });
      this.finalizeRasterPresentation(entry, obj, postFilterStr, postSvgFilters);
    } catch {
      restoreCaptureVisibility();
      if (entry.rasterCompletedKey === rasterRunKey && entry.rasterCanvas) {
        this.reapplyAdjustmentSuppression(obj.id, adjustZ);
      } else if (entry.rasterCompletedKey !== rasterRunKey) {
        this.clearRasterOverlay(entry);
        this.restoreAdjustmentSuppression(obj.id);
      }
    } finally {
      if (entry.rasterInFlightKey === rasterRunKey) entry.rasterInFlightKey = null;
    }
  }

  // html comp のメタ情報を DomRenderer に注入する（ProximityPanel / store から呼ぶ）。
  private pendingHtmlComps: Map<string, HtmlComposition> | null = null;

  setHtmlComps(comps: Map<string, HtmlComposition>): void {
    this.pendingHtmlComps = comps;
  }

  // §23 timeline comp ネスト用: 現プロジェクトの timeline comp 一覧を注入する。
  private pendingTimelineComps: Map<string, TimelineComposition> | null = null;

  setTimelineComps(comps: Map<string, TimelineComposition>): void {
    this.pendingTimelineComps = comps;
  }

  // §23 ネスト comp をコンテナ div に描画する (Phase 1: 非 reconcile、solid/text/image のみ対応)。
  // html/plugin component を含む子オブジェクトは描画されない（Phase 2 以降で対応）。
  // depth で無限ループを防ぐ（循環参照が挿入時に阻止されるが念のため）。
  private renderNestedComp(container: HTMLElement, childComp: TimelineComposition, childFrame: Frame, depth: number): void {
    if (!isCompNestDepthAllowed(depth)) return;

    // §28.11 — ラスター化対象のネスト comp は comp 単位画像（blob URL）で描く。
    if (this.nestedCompRasterizer?.isRasterized(childComp.id)) {
      this.renderNestedCompRaster(container, childComp, childFrame);
      return;
    }

    const childScene = resolve(childComp, childFrame);
    container.style.cssText = `position:absolute;top:0;left:0;width:${childComp.width}px;height:${childComp.height}px;overflow:hidden;transform-style:preserve-3d`;
    if (childComp.background) container.style.background = rgbaCss(childComp.background);
    else container.style.background = "";

    // 毎フレーム再描画（Phase 1 簡易実装。html/plugin comp は対象外）
    container.innerHTML = "";
    for (const obj of childScene.objects) {
      const div = document.createElement("div");
      div.style.cssText = `position:absolute;top:0;left:0;transform-origin:0 0;transform:${mat4ToCss(obj.worldTransform)};opacity:${obj.opacity};z-index:${Math.round(obj.zOrder * BASE_Z)}`;
      for (const c of obj.components) {
        if (c.type === "comp") {
          // ネストされた comp は再帰描画（深度制限付き）
          const nestedCompId = c.props["compId"] as string | undefined;
          const nestedComp = this.pendingTimelineComps?.get(nestedCompId ?? "");
          if (nestedComp) {
            const innerEl = document.createElement("div");
            const inPoint = (c.props["_inPoint"] as number) ?? 0;
            const trimStart = (c.props["trimStart"] as number) ?? 0;
            const nestedFrame = compChildFrame(childFrame, inPoint, trimStart, nestedComp.duration);
            this.renderNestedComp(innerEl, nestedComp, nestedFrame, depth + 1);
            div.appendChild(innerEl);
          }
          continue;
        }
        const el = createComponentEl(c.type);
        const hostInPoint = (c.props["_hostInPoint"] as number | undefined) ?? 0;
        updateComponentEl(el, c.type, c.props, this.textQuality, this.fontCache, this.imageCache, childFrame, hostInPoint, childComp.fps);
        div.appendChild(el);
      }
      container.appendChild(div);
    }
  }

  // §28.11 — ネスト comp を comp 単位画像で描画。単一 <img> を再利用し、新フレームの
  // raster を非同期取得して swap する。取得待ちの間は直前の画像を保持（ちらつき回避）。
  private renderNestedCompRaster(container: HTMLElement, childComp: TimelineComposition, childFrame: Frame): void {
    container.style.cssText = `position:absolute;top:0;left:0;width:${childComp.width}px;height:${childComp.height}px;overflow:hidden`;
    if (childComp.background) container.style.background = rgbaCss(childComp.background);
    else container.style.background = "";

    let img = container.firstElementChild as HTMLImageElement | null;
    if (!img || img.tagName !== "IMG" || img.dataset["precompRaster"] !== "1") {
      container.innerHTML = "";
      img = document.createElement("img");
      img.dataset["precompRaster"] = "1";
      img.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:fill;";
      container.appendChild(img);
    }
    const reqImg = img;
    // 最新リクエストのみ反映するためのトークン（dataset 経由・古い結果は破棄）。
    reqImg.dataset["reqFrame"] = String(childFrame);
    const rasterizer = this.nestedCompRasterizer;
    if (!rasterizer) return;
    void rasterizer.getRaster(childComp.id, childFrame).then((url) => {
      if (!url) return;
      // 取得中に別フレームが要求されていたら破棄。
      if (reqImg.dataset["reqFrame"] !== String(childFrame)) return;
      if (reqImg.src !== url) reqImg.src = url;
    });
  }
}

function updateComponentEl(
  el: HTMLElement,
  type: string,
  props: ResolvedComponent["props"],
  textQuality: "draft" | "precise" = "draft",
  fontCache: FontOutlineCache | null = null,
  imageCache: ImageAssetCache | null = null,
  hostFrame = 0,
  hostInPoint = 0,
  fps = 30,
): void {
  switch (type) {
    case "solid": {
      const color = props["color"] as RGBA | undefined;
      const size = props["size"] as { x: number; y: number } | undefined;
      el.style.width = size ? `${size.x}px` : "100%";
      el.style.height = size ? `${size.y}px` : "100%";
      el.style.background = color ? rgbaCss(color) : "#888";
      break;
    }
    case "shape": {
      const fill = props["fill"] as RGBA | undefined;
      const size = props["size"] as { x: number; y: number } | undefined;
      const kind = props["kind"] as string | undefined;
      const radius = props["radius"] as number | undefined;
      el.style.width = size ? `${size.x}px` : "100px";
      el.style.height = size ? `${size.y}px` : "100px";
      el.style.background = fill ? rgbaCss(fill) : "#888";
      el.style.borderRadius = kind === "ellipse" ? "50%" : radius ? `${radius}px` : "0";
      break;
    }
    case "text": {
      const fontFamily = typeof props["font"] === "string" ? props["font"] : "sans-serif";
      const font = fontCache?.getFont(fontFamily) ?? null;
      applyTextEl(el, props, textQuality, font);
      break;
    }
    case "image": {
      const img = el as HTMLImageElement;
      const fit = props["fit"] as string | undefined;
      img.style.objectFit = (fit as "contain" | "cover" | "fill") ?? "contain";
      const assetId = props["asset"] as string | undefined;
      const src = assetId ? (imageCache?.getUrl(assetId) ?? "") : "";
      if (img.getAttribute("src") !== src) img.src = src;
      const size = assetId ? imageCache?.getSize(assetId) : null;
      if (size) {
        img.style.width = `${size.width}px`;
        img.style.height = `${size.height}px`;
      }
      break;
    }
    case "video": {
      const video = el as HTMLVideoElement;
      const assetId = props["asset"] as string | undefined;
      const src = assetId ? (imageCache?.getUrl(assetId) ?? "") : "";
      if (video.getAttribute("src") !== src) {
        video.src = src;
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
      }
      const trimStart = (props["trimStart"] as number | undefined) ?? 0;
      const t = Math.max(0, (hostFrame - hostInPoint) / fps + trimStart / fps);
      if (Number.isFinite(t) && Math.abs(video.currentTime - t) > 0.05) {
        try {
          video.currentTime = t;
        } catch {
          /* seek best-effort */
        }
      }
      const size = assetId ? imageCache?.getSize(assetId) : null;
      if (size) {
        video.style.width = `${size.width}px`;
        video.style.height = `${size.height}px`;
      }
      break;
    }
  }
}

function mat4ToCss(m: readonly number[]): string {
  return `matrix3d(${m.join(",")})`;
}

function createComponentEl(type: string): HTMLElement {
  if (type === "image") {
    const img = document.createElement("img");
    img.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
    return img;
  }
  if (type === "video") {
    const video = document.createElement("video");
    video.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
    return video;
  }
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
  return el;
}
