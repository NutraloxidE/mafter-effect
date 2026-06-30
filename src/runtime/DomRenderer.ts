import { DISPLACEMENT_EFFECT_TYPES, FAST_DISPLACEMENT_EFFECT_TYPES } from "./effectSvg";
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
import { resolve, type ExpressionEvaluator } from "./resolve";
import { applyTextEl, rgbaCss } from "./textRender";
import { captureElementToCanvas } from "./rasterCapture";
import { canvasToRasterBuffer, rasterBufferToCanvas } from "./pixelSort";
import { processRasterChainAsync } from "./rasterProcessAsync";
import { applyFilterChainToBuffer } from "./effectRaster";
import { resolveEffectChain } from "./effectChain";
import { EXPORT_VIDEO_TARGET_ATTR, primeVideoElement, syncVideoElementTime, waitForVideoFrame } from "./videoElementSync";
import { ensureVideosPrimed, peekVideoPrimed, type VideoPrimeTarget } from "./videoWarmupCache";
import { KeyedElementPool } from "./videoElementPool";
import type { ExportChain, ExportLayer, NestedCompositeMeta, ExportTaggedElement } from "./exportComposite";
import type { EffectFilter } from "./plugin";
import type { BlendMode } from "../core/schema";
import { isCssBlendMode } from "./blendCompose";
import { ditherTileDataUrl } from "./ditherMask";
import { multiply, translation, type Mat4 } from "./mat4";

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

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * §5.4d 描画モードを div の style に反映する（トップレベル・ネスト comp 共用の純ヘルパ）。
 * - 16種: `mix-blend-mode`（normal はクリア）。ラスター化ゼロのネイティブ合成。
 * - ditherDissolve: `mask-image` に Bayer ディザを敷き、opacity を閾値へ回す（div α は 1 固定・AE 準拠）。
 */
/** §6.5b / §23.3b — 3D 層のみ cameraPre を掛け、2D 層は免除。 */
function objectWorldTransformWithCamera(cameraPre: Mat4 | null, obj: ResolvedObject): Mat4 {
  return cameraPre && obj.threeD === true
    ? multiply(cameraPre, obj.worldTransform)
    : obj.worldTransform;
}

function setBlendModeStyle(el: HTMLElement, blend: BlendMode, opacity: number): void {
  const s = el.style;
  if (blend === "ditherDissolve") {
    s.mixBlendMode = "";
    s.opacity = "1";
    const url = ditherTileDataUrl(opacity);
    const ref = url ? `url(${url})` : "";
    s.setProperty("mask-image", ref);
    s.setProperty("-webkit-mask-image", ref);
    s.setProperty("mask-repeat", "repeat");
    s.setProperty("-webkit-mask-repeat", "repeat");
  } else {
    // dither マスクをクリア（前フレームが dither だった場合の残留防止）。
    s.setProperty("mask-image", "");
    s.setProperty("-webkit-mask-image", "");
    s.mixBlendMode = isCssBlendMode(blend) ? blend : "";
  }
}

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
  /** §5.4d 現フレームの描画モード（capture コンポジタが参照） */
  blendMode: BlendMode;
  /** §6.5b export 調整 backdrop capture 用（threeD 層のスナップショット化） */
  threeD: boolean;
  /** §27.4 現フレームが調整レイヤーか（exportComposite の z 順合成で参照） */
  isAdjustment: boolean;
  /** §27.4 export — 解決済み effect chain（exportComposite が背面 master へ適用）。非調整は null。 */
  exportChain: ExportChain | null;
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

  /**
   * §11.4 カット境界の `<video>` 要素再利用プール。key=assetId、value=離脱して空いた要素。
   * 同一動画の連結カットで境界レイヤーが入れ替わる際、破棄→新規生成（=再ロード/再デコード）の
   * 代わりに同一アセットの decode 済み要素を再利用してデコードギャップ（空フレーム・音の再初期化）を防ぐ。
   * preview/bundle 専用。export 経路は waitForVideoFrame がデコードを待つため決定論不変（INV-2）。
   */
  private videoPool = new KeyedElementPool<HTMLVideoElement>();

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
  /** §23.3d export — 現フレームに再帰合成が必要なネスト comp があるか（exportComposite 高速経路の除外判定）。 */
  private frameHasNestedComposite = false;
  /** §6.5b per-object カメラ前置行列 = translate(cx,cy,P)·view。3D 層にのみ掛ける。null = カメラなし。 */
  private cameraPre: Mat4 | null = null;
  /** §27.12 hold-last raster（full displacement 用）。 */
  private holdLastRaster = false;
  /** §27.4 auto_raster_mp4 — mp4/png export 時に Live調整も comp 背面 capture へ回す
   *  （backdrop-filter は foreignObject ラスタ化で消えるため）。web bundle/preview では false。 */
  private forceAdjustmentRaster = false;
  /** §27.4.1 export — Live 調整 bake を zOrder 直列化（preview compositor 相当） */
  private exportAdjustmentQueue: Promise<void> = Promise.resolve();
  /** §27.4 export — オフDOM コンポジタ（exportComposite.ts）が調整合成を担う。true の間、
   *  調整レイヤーは live DOM を破壊せず effect chain を entry.exportChain に保存するだけ。 */
  private exportCompositeMode = false;
  /** preview 再生中は video を play() で進め、フレーム毎 seek を避ける。 */
  private previewVideoPlayback = false;
  /** export 中は video を play ステップで進め、毎フレーム seek を避ける。 */
  private exportVideoStep = false;

  setPreviewRenderOptions(opts: {
    holdLastRaster?: boolean;
    forceAdjustmentRaster?: boolean;
    exportCompositeMode?: boolean;
    previewVideoPlayback?: boolean;
    exportVideoStep?: boolean;
  }): void {
    if (opts.holdLastRaster !== undefined) this.holdLastRaster = opts.holdLastRaster;
    if (opts.forceAdjustmentRaster !== undefined) this.forceAdjustmentRaster = opts.forceAdjustmentRaster;
    if (opts.exportCompositeMode !== undefined) this.exportCompositeMode = opts.exportCompositeMode;
    if (opts.exportVideoStep !== undefined) this.exportVideoStep = opts.exportVideoStep;
    if (opts.previewVideoPlayback !== undefined) {
      if (this.previewVideoPlayback && !opts.previewVideoPlayback) {
        this.pauseAllVideos();
      }
      this.previewVideoPlayback = opts.previewVideoPlayback;
    }
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

    if (this.forceAdjustmentRaster) {
      this.exportAdjustmentQueue = Promise.resolve();
    }

    this.compHasAdjustmentDisplace = scene.objects.some(
      (o) =>
        o.isAdjustment === true &&
        (o.effects ?? []).some((e) => e.enabled && DISPLACEMENT_EFFECT_TYPES.has(e.type)),
    );

    // §23.3d export — renderNestedComp が「再帰合成が必要なネスト comp」を見つけたら true にする。
    this.frameHasNestedComposite = false;

    // camera / perspective (§6.5 / §6.5b)
    this.cameraPre = this.setupCameraRig(this.root, scene);

    const seen = new Set<string>();
    for (const obj of scene.objects) {
      if (!obj.isNull) seen.add(obj.id);
    }

    // 離脱オブジェクトの削除は入場処理より前に行う。
    // §11.4 カット境界（離脱と入場が同一フレーム）で、入場レイヤーが子 <video> を生成する前に
    // 離脱レイヤーの <video> をプールへ退避しておかないと再利用できない（順序が肝）。
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        this.restoreAdjustmentSuppression(id);
        // §11.4 配下の <video> は破棄せずプールへ退避（同一アセットのカット境界で再利用する）。
        this.stashVideosToPool(entry);
        entry.div.remove();
        this.entries.delete(id);
        this.htmlPlayer?.unmountObject(id);
      }
    }

    for (const obj of scene.objects) {
      if (obj.isNull) continue;
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
          blendMode: "normal",
          threeD: false,
          isAdjustment: false,
          exportChain: null,
        };
        this.entries.set(obj.id, entry);
      }
      entry.threeD = obj.threeD === true;
      this.applyObject(entry, obj, frame);
    }
  }

  /**
   * §11.4 離脱した entry の `<video>` を assetId 単位プールへ退避する（破棄しない）。
   * DOM からは外すが要素参照・src・デコーダ状態は保持し、muted+pause 済みにする（音漏れ防止）。
   */
  private stashVideosToPool(entry: ObjectEntry): void {
    for (const el of entry.children) {
      if (!(el instanceof HTMLVideoElement)) continue;
      const assetId = el.dataset.mafterVideoAsset;
      if (!assetId) continue;
      try {
        el.muted = true;
        if (!el.paused) el.pause();
      } catch {
        /* muted/pause best-effort */
      }
      if (el.parentNode) el.parentNode.removeChild(el);
      this.videoPool.stash(assetId, el);
    }
  }

  /** §11.4 同一アセットの空き `<video>` をプールから1つ取り出す（無ければ null）。 */
  private acquireVideoFromPool(assetId: string): HTMLVideoElement | null {
    return this.videoPool.acquire(assetId);
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

  /** export 前に video seek / decode 完了を待つ（foreignObject は video を描けない）。 */
  async flushVideoFrames(): Promise<void> {
    if (!this.root) return;
    const videos = [...this.root.querySelectorAll("video")];
    if (videos.length === 0) return;
    await Promise.all(videos.map((v) => {
      const raw = v.getAttribute(EXPORT_VIDEO_TARGET_ATTR);
      const target = raw !== null && raw !== "" ? Number(raw) : undefined;
      return waitForVideoFrame(v, Number.isFinite(target) ? target : undefined);
    }));
  }

  /** §11.4 preview/bundle warm-up — マウント済み video 要素を列挙（ネスト comp 内も含む）。 */
  forEachVideoElement(cb: (video: HTMLVideoElement, objectId: string) => void): void {
    if (!this.root) return;
    for (const v of this.root.querySelectorAll("video")) {
      const host = (v as HTMLElement).closest("[data-object-id]") as HTMLElement | null;
      cb(v, host?.dataset.objectId ?? "");
    }
  }

  /**
   * §11.4 preview/bundle warm-up — 現 DOM 上の各 video を dataset の target 時刻へ prime する。
   * export 経路（exportStep + waitForVideoFrame の決定論 seek/present）とは無関係（INV-2 非干渉）。
   * primed は videoWarmupCache に記録し再 prime を去重。全 video 成功で true。
   */
  async primeMountedVideos(fps: number, timeoutMs?: number): Promise<boolean> {
    if (!this.root) return true;
    const targets: VideoPrimeTarget[] = [];
    this.forEachVideoElement((video) => {
      const assetId = video.dataset.mafterVideoAsset;
      const rawT = video.dataset.mafterTargetSec;
      if (!assetId || rawT === undefined) return;
      const targetSec = Number(rawT);
      if (!Number.isFinite(targetSec)) return;
      targets.push({
        assetId,
        targetSec,
        fps,
        prime: () => primeVideoElement(video, targetSec, fps, timeoutMs),
      });
    });
    return ensureVideosPrimed(targets);
  }

  /** §11.4 — 現 DOM 上の全 video が現フレームで warm-up 済みか（play gate スキップ判定）。 */
  areMountedVideosPrimed(fps: number): boolean {
    if (!this.root) return true;
    let allPrimed = true;
    this.forEachVideoElement((video) => {
      const assetId = video.dataset.mafterVideoAsset;
      const rawT = video.dataset.mafterTargetSec;
      if (!assetId || rawT === undefined) return;
      const targetSec = Number(rawT);
      if (!Number.isFinite(targetSec)) return;
      if (!peekVideoPrimed(assetId, targetSec, fps)) allPrimed = false;
    });
    return allPrimed;
  }

  /**
   * §11.2 / §27.4.1 — mp4/png export 用 composite flush。
   * 非調整 raster を並列待ちした後、Live 調整 bake（forceAdjustmentRaster）を zOrder 直列キューで待つ。
   */
  async flushExportComposite(): Promise<void> {
    await this.flushRasterEffects();
    await this.exportAdjustmentQueue;
  }

  private trackRasterWork(work: Promise<void>, serialExportAdjustment: boolean): void {
    const tracked = work.finally(() => {
      if (!serialExportAdjustment) this.rasterPending.delete(tracked);
    });
    if (serialExportAdjustment) {
      this.exportAdjustmentQueue = this.exportAdjustmentQueue.then(() => tracked);
    } else {
      this.rasterPending.add(tracked);
    }
  }

  /** §27.4.1 — 調整 backdrop capture 前の visibility。確定済み（suppressed）下位は再表示しない。 */
  private prepareAdjustmentBackdropForCapture(
    adjustObjId: string,
    adjustZ: number,
  ): { hiddenForCapture: HTMLElement[]; restoreCaptureVisibility: () => void } {
    const hiddenForCapture: HTMLElement[] = [];

    for (const [id, other] of this.entries) {
      const z = parseInt(other.div.style.zIndex, 10);
      if (id === adjustObjId || z <= adjustZ) continue;
      hiddenForCapture.push(other.div);
      other.div.style.visibility = "hidden";
    }
    const selfEntry = this.entries.get(adjustObjId);
    if (selfEntry) {
      hiddenForCapture.push(selfEntry.div);
      selfEntry.div.style.visibility = "hidden";
    }

    for (const [id, other] of this.entries) {
      const z = parseInt(other.div.style.zIndex, 10);
      if (id === adjustObjId || z >= adjustZ) continue;
      if (other.suppressedForAdjustment !== null) {
        other.div.style.visibility = "hidden";
        continue;
      }
      other.div.style.visibility = "visible";
    }

    return {
      hiddenForCapture,
      restoreCaptureVisibility: () => {
        for (const div of hiddenForCapture) div.style.visibility = "";
      },
    };
  }

  private shouldSerialExportAdjustment(obj: ResolvedObject): boolean {
    return (
      obj.isAdjustment === true &&
      (obj.adjustmentMode === "raster" || this.forceAdjustmentRaster === true)
    );
  }

  dispose(): void {
    this.pauseAllVideos();
    // §11.4 プールに退避した <video> も明示破棄（src 解放・リーク防止）。
    for (const el of this.videoPool.drain()) {
      try {
        el.pause();
        el.removeAttribute("src");
        el.load();
      } catch {
        /* teardown best-effort */
      }
    }
    if (this.root) {
      this.root.remove();
      this.root = null;
    }
    this.entries.clear();
    this.currentComp = null;
  }

  private pauseAllVideos(): void {
    for (const entry of this.entries.values()) {
      for (const el of entry.children) {
        if (el instanceof HTMLVideoElement) {
          // §11.4 停止時はミュートも戻す（次のスクラブ前の音漏れ防止）。
          try {
            el.muted = true;
          } catch {
            /* muted best-effort */
          }
          if (!el.paused) {
            try {
              el.pause();
            } catch {
              /* pause best-effort */
            }
          }
        }
      }
    }
  }

  private applyObject(entry: ObjectEntry, obj: ResolvedObject, frame: Frame): void {
    // §6.5b/§5.4b 3D 層（threeD）のみカメラ view を per-object で焼く（root perspective を受けて
    // dolly/zoom が効く）。2D 層は素の worldTransform = カメラ免除（AE 準拠, z=0 で perspective 無歪み）。
    const xform = objectWorldTransformWithCamera(this.cameraPre, obj);
    entry.div.style.transform = mat4ToCss(xform);
    entry.div.style.opacity = String(obj.opacity);
    entry.div.style.zIndex = String(Math.round(obj.zOrder * BASE_Z));

    // §5.4d 描画モード。毎フレーム明示設定/クリア（前フレームの残留を防ぐ）。
    this.applyBlendMode(entry, obj.blendMode, obj.opacity);

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
        // §11.4 video は同一アセットの decode 済み要素をプールから再利用（境界の空フレーム回避）。
        const assetId = c.type === "video" ? (c.props["asset"] as string | undefined) : undefined;
        const el =
          assetId && assetId !== ""
            ? (this.acquireVideoFromPool(assetId) ?? createComponentEl("video"))
            : createComponentEl(c.type);
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
        updateComponentEl(el, c.type, c.props, this.textQuality, this.fontCache, this.imageCache, frame, hostInPoint, this.currentComp?.fps ?? 30, this.previewVideoPlayback, this.exportVideoStep);
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
          const parentFps = (c.props["_parentFps"] as number) ?? childComp.fps;
          const childFrame = compChildFrame(frame, inPoint, trimStart, childComp.duration, parentFps, childComp.fps);
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

  /**
   * §5.4d 描画モードを CSS に反映する。
   * - 16 種: `mix-blend-mode`（normal はクリア）。ラスター化ゼロのネイティブ合成。
   * - ditherDissolve: `mask-image` に Bayer ディザを敷き、opacity をディザ閾値へ回す
   *   （div α は 1 に固定・AE 準拠）。
   */
  private applyBlendMode(entry: ObjectEntry, blend: BlendMode, opacity: number): void {
    entry.blendMode = blend;
    setBlendModeStyle(entry.div, blend, opacity);
  }

  /** §5.4d capture — comp 内に CSS mix-blend を持つレイヤーがあるか（Canvas 合成要否判定）。 */
  hasCssBlendLayers(): boolean {
    for (const entry of this.entries.values()) {
      if (isCssBlendMode(entry.blendMode)) return true;
    }
    return false;
  }

  /** §5.4d capture — z 順（昇順）のレイヤー div と描画モードを返す。Canvas 合成用。 */
  getCompositeLayers(): { div: HTMLElement; blendMode: BlendMode }[] {
    const layers = [...this.entries.values()].map((e) => ({
      div: e.div as HTMLElement,
      blendMode: e.blendMode,
      z: Number(e.div.style.zIndex) || 0,
    }));
    layers.sort((a, b) => a.z - b.z);
    return layers.map(({ div, blendMode }) => ({ div, blendMode }));
  }

  /** §27.4 — 現フレームに調整レイヤーが 1 つでもあるか（exportComposite の経路選択用）。 */
  hasAdjustmentLayers(): boolean {
    for (const e of this.entries.values()) if (e.isAdjustment) return true;
    return false;
  }

  /** §23.3d — 現フレームに「再帰合成が必要なネスト comp」があるか（exportComposite の経路選択用）。 */
  hasNestedComposite(): boolean {
    return this.frameHasNestedComposite;
  }

  /** §27.4.1 — exportComposite 用の z 昇順レイヤ列。調整レイヤーは effect chain 付き。 */
  getExportLayers(): ExportLayer[] {
    const layers = [...this.entries.values()].map((e) => ({
      div: e.div as HTMLElement,
      blendMode: e.blendMode,
      isAdjustment: e.isAdjustment,
      exportChain: e.isAdjustment ? e.exportChain : null,
      z: Number(e.div.style.zIndex) || 0,
    }));
    layers.sort((a, b) => a.z - b.z);
    return layers.map(({ div, blendMode, isAdjustment, exportChain }) => ({
      div,
      blendMode,
      isAdjustment,
      exportChain,
    }));
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

    const chain = resolveEffectChain(effects, ctx, `fx-${obj.id}`);
    const { preTokens, postTokens, preSvgFilters, postSvgFilters, rasterChain } = chain;
    entry.fxLayerW = Math.max(1, Math.round(ctx.width));
    entry.fxLayerH = Math.max(1, Math.round(ctx.height));
    entry.fxMaxDisplaceScale = chain.fxMaxDisplaceScale;
    entry.fxUseBackdropDisplace = obj.isAdjustment === true && chain.hasDisplacementFx;

    if (chain.hasDisplacementFx && !obj.isAdjustment) {
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

    // §27.4 export — オフDOM コンポジタ（exportComposite.ts）が背面 master へ焼くための解決済み chain を保存。
    entry.isAdjustment = obj.isAdjustment === true;
    if (obj.isAdjustment) {
      entry.exportChain = {
        preFilterStr: preTokens.join(" "),
        preSvgFilters,
        postFilterStr: postTokens.join(" "),
        postSvgFilters,
        rasterChain,
        region: {
          fxLayerW: entry.fxLayerW,
          fxLayerH: entry.fxLayerH,
          fxMaxDisplaceScale: entry.fxMaxDisplaceScale,
          fxUseBackdropDisplace: entry.fxUseBackdropDisplace,
        },
        frame: ctx.frame,
      };
      if (this.exportCompositeMode) {
        // 調整合成は exportComposite が master 上で行う。live DOM に overlay/suppression/backdrop を残さない。
        this.clearRasterOverlay(entry);
        this.restoreAdjustmentSuppression(obj.id);
        this.applyFilterTokens(entry, obj, [], []);
        return;
      }
    } else {
      entry.exportChain = null;
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
        this.trackRasterWork(work, this.shouldSerialExportAdjustment(obj));
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
    this.trackRasterWork(work, this.shouldSerialExportAdjustment(obj));
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
      buffer = await applyFilterChainToBuffer(buffer, w, h, filterStr, svgFilters, filterEntry);

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

    const { restoreCaptureVisibility } = this.prepareAdjustmentBackdropForCapture(obj.id, adjustZ);

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

      const canvas = await this.captureAdjustmentBackdrop(w, h);
      restoreCaptureVisibility();

      let buffer = canvasToRasterBuffer(canvas);
      const filterEntry: Pick<ObjectEntry, "fxLayerW" | "fxLayerH" | "fxMaxDisplaceScale" | "fxUseBackdropDisplace"> = {
        fxLayerW: w,
        fxLayerH: h,
        fxMaxDisplaceScale: entry.fxMaxDisplaceScale,
        fxUseBackdropDisplace: false,
      };
      buffer = await applyFilterChainToBuffer(buffer, w, h, filterStr, svgFilters, filterEntry);

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

  /**
   * §11.2 export — 調整レイヤーの背面 capture。
   * captureElementToCanvas（foreignObject）は CSS 3D transform / perspective も含めて root を
   * そのままラスタ化できる（Comp 10 f100 のネスト 3D comp で実証済み）。かつて下位 3D 層を
   * 個別 capture→img 置換していたが、それ自体が 3D コンテンツを空 img に潰し「消える」症状の
   * 原因だった。root を直接 capture すればコンテンツも effect も preview に一致する。
   */
  private async captureAdjustmentBackdrop(w: number, h: number): Promise<HTMLCanvasElement> {
    if (!this.root) throw new Error("captureAdjustmentBackdrop: no root");
    return captureElementToCanvas(this.root, w, h, "transparent");
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
    const { restoreCaptureVisibility } = this.prepareAdjustmentBackdropForCapture(obj.id, adjustZ);

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

      const canvas = await this.captureAdjustmentBackdrop(w, h);
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

  // §23.3b ネスト comp の expression 用: comp ごとの ExpressionEvaluator を注入する。
  // renderNestedComp は子 comp を自前で resolve() するため、トップレベルと違い evaluator が
  // 渡されないと nested comp 内の expression（opacity/effect param 含む）が静的化する。
  private pendingCompEvaluators: Map<string, ExpressionEvaluator> | null = null;

  setCompEvaluators(evaluators: Map<string, ExpressionEvaluator>): void {
    this.pendingCompEvaluators = evaluators;
  }

  /**
   * §6.5b / §23.3b — コンテナに perspective を設定し、3D 層用の cameraPre を返す。
   * カメラ無しの場合は perspective をクリアし null を返す（ネスト無カメラ comp の無回帰）。
   */
  private setupCameraRig(
    container: HTMLElement,
    scene: { camera?: { fov: number; viewMatrix: Mat4 }; width: number; height: number },
  ): Mat4 | null {
    if (scene.camera) {
      const perspective = scene.height / 2 / Math.tan((scene.camera.fov * Math.PI) / 360);
      container.style.perspective = `${perspective}px`;
      container.style.perspectiveOrigin = "50% 50%";
      // view を root transform に置くと dolly/zoom が効かない（§6.5b）。3D 層へ per-object で焼く。
      container.style.transform = "";
      return multiply(
        translation(scene.width / 2, scene.height / 2, perspective),
        scene.camera.viewMatrix,
      );
    }
    container.style.perspective = "";
    container.style.transform = "";
    return null;
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

    // §23.3b: 子 comp の expression を評価するため comp 固有の evaluator を渡す。
    // 渡さないと nested comp 内の wiggle 等が静的化し、opacity/effect param も動かない。
    const childScene = resolve(childComp, childFrame, {
      expressions: this.pendingCompEvaluators?.get(childComp.id),
    });
    // §23.3a: isolation:isolate で内部ブレンドを precomp 内に閉じる（AE collapse OFF 相当）。
    // これで mix-blend-mode が外側へ漏れず、export の単一 capture でも内部ブレンドがネイティブに焼ける。
    container.style.cssText = `position:absolute;top:0;left:0;width:${childComp.width}px;height:${childComp.height}px;overflow:hidden;transform-style:preserve-3d;isolation:isolate`;
    if (childComp.background) container.style.background = rgbaCss(childComp.background);
    else container.style.background = "";
    // §23.3b: ネスト comp は自身のカメラを live で適用（§6.5b と同一リグ）。
    const cameraPre = this.setupCameraRig(container, childScene);

    // 毎フレーム再描画（Phase 1 簡易実装。html/plugin comp は対象外）
    container.innerHTML = "";
    // §23.3d export — この comp（再帰的に）に調整レイヤーがあれば子座標系で1枚へ確定する必要がある。
    let needsComposite = false;
    for (const obj of childScene.objects) {
      const div = document.createElement("div");
      const xform = objectWorldTransformWithCamera(cameraPre, obj);
      const isAdj = obj.isAdjustment === true;
      if (isAdj) {
        // §23.3d: 調整レイヤーは comp 全面の空 div とし、effect を backdrop-filter で背後へ効かせる。
        // コンテンツ component は描かない（背後を覆わないため）。
        div.style.cssText = `position:absolute;top:0;left:0;transform-origin:0 0;transform:${mat4ToCss(xform)};opacity:${obj.opacity};z-index:${Math.round(obj.zOrder * BASE_Z)};width:${childComp.width}px;height:${childComp.height}px;background:transparent;pointer-events:none`;
      } else {
        div.style.cssText = `position:absolute;top:0;left:0;transform-origin:0 0;transform:${mat4ToCss(xform)};opacity:${obj.opacity};z-index:${Math.round(obj.zOrder * BASE_Z)}`;
        for (const c of obj.components) {
          if (c.type === "comp") {
            // ネストされた comp は再帰描画（深度制限付き）
            const nestedCompId = c.props["compId"] as string | undefined;
            const nestedComp = this.pendingTimelineComps?.get(nestedCompId ?? "");
            if (nestedComp) {
              const innerEl = document.createElement("div");
              const inPoint = (c.props["_inPoint"] as number) ?? 0;
              const trimStart = (c.props["trimStart"] as number) ?? 0;
              const parentFps = (c.props["_parentFps"] as number) ?? childComp.fps;
              const nestedFrame = compChildFrame(childFrame, inPoint, trimStart, nestedComp.duration, parentFps, nestedComp.fps);
              this.renderNestedComp(innerEl, nestedComp, nestedFrame, depth + 1);
              // §23.3d: 深い子に調整があれば、この comp も親の単一 capture では焼けない（再帰合成へ）。
              if ((innerEl as ExportTaggedElement).__nestedComposite?.needsComposite) needsComposite = true;
              div.appendChild(innerEl);
            }
            continue;
          }
          const el = createComponentEl(c.type);
          const hostInPoint = (c.props["_hostInPoint"] as number | undefined) ?? 0;
          updateComponentEl(el, c.type, c.props, this.textQuality, this.fontCache, this.imageCache, childFrame, hostInPoint, childComp.fps, this.previewVideoPlayback, this.exportVideoStep);
          div.appendChild(el);
        }
      }
      container.appendChild(div);
      // §23.3a: トップレベルと挙動を揃える（ラスタ無し・append 後に実測サイズで filter region 決定）。
      setBlendModeStyle(div, obj.blendMode, obj.opacity);

      if (this.exportCompositeMode) {
        // §23.3d export — backdrop-filter は foreignObject で落ちるため、調整は live に立てず
        // 解決済み chain をレイヤメタに保存し、exportComposite が子座標系で背面 master へ焼く。
        let exportChain: ExportChain | null = null;
        if (isAdj) {
          const ctx = { width: childComp.width, height: childComp.height, frame: childFrame };
          const ec = resolveEffectChain(obj.effects ?? [], ctx, `nfx-${obj.id}`);
          exportChain = {
            preFilterStr: ec.preTokens.join(" "),
            preSvgFilters: ec.preSvgFilters,
            postFilterStr: ec.postTokens.join(" "),
            postSvgFilters: ec.postSvgFilters,
            rasterChain: ec.rasterChain,
            region: {
              fxLayerW: Math.max(1, Math.round(childComp.width)),
              fxLayerH: Math.max(1, Math.round(childComp.height)),
              fxMaxDisplaceScale: ec.fxMaxDisplaceScale,
              fxUseBackdropDisplace: ec.hasDisplacementFx,
            },
            frame: childFrame,
          };
          needsComposite = true;
        } else {
          // 通常レイヤーの live filter は foreignObject で焼けるので従来どおり適用。
          this.applyNestedLiveEffects(div, obj, childFrame, childComp.width, childComp.height);
        }
        (div as ExportTaggedElement).__exportLayer = {
          div,
          blendMode: obj.blendMode,
          isAdjustment: isAdj,
          exportChain,
        };
      } else {
        // preview: 調整は backdrop-filter（region=comp 寸法）、通常は filter（region=実測 div）。
        this.applyNestedLiveEffects(div, obj, childFrame, childComp.width, childComp.height);
      }
    }

    if (this.exportCompositeMode) {
      const meta: NestedCompositeMeta = {
        needsComposite,
        perspective: container.style.perspective,
        perspectiveOrigin: container.style.perspectiveOrigin || "50% 50%",
        width: childComp.width,
        height: childComp.height,
        background: childComp.background ? rgbaCss(childComp.background) : "transparent",
      };
      (container as ExportTaggedElement).__nestedComposite = meta;
      container.setAttribute("data-nested-composite", needsComposite ? "1" : "0");
      if (needsComposite) this.frameHasNestedComposite = true;
    }
  }

  /**
   * §23.3a/§23.3d — ネスト comp 内オブジェクトに live filter 系 effect を適用する（ラスタ無し）。
   * `EffectDef.apply()` の css/svg ピースのみ。`kind:"raster"` と full displacement
   * （wave/ripple/turbulentDisplace）は raster 経路を要するため live では適用しない
   * （それらは §28.11 の comp 単位ラスタ経路で反映される）。
   *
   * 調整レイヤー（§23.3d）は `backdrop-filter` で背後（自 precomp 内の下位レイヤー）へ効かせる。
   * 中身が空で実寸が取れないため filter region は comp 寸法（compW/compH）でクランプする。
   * 通常レイヤーは従来どおり `filter`（region=実測 div サイズ、fallback=comp 寸法）。
   */
  private applyNestedLiveEffects(
    div: HTMLElement,
    obj: ResolvedObject,
    frame: Frame,
    compW: number,
    compH: number,
  ): void {
    const effects = obj.effects ?? [];
    if (effects.length === 0) return;
    const isAdj = obj.isAdjustment === true;
    const w = isAdj ? Math.max(1, Math.round(compW)) : Math.max(1, Math.round(div.offsetWidth || compW || 0));
    const h = isAdj ? Math.max(1, Math.round(compH)) : Math.max(1, Math.round(div.offsetHeight || compH || 0));
    const ctx = { width: w, height: h, frame };
    const tokens: string[] = [];
    const svgFilters: { id: string; primitives: string }[] = [];
    let i = 0;
    for (const effect of effects) {
      if (!effect.enabled) continue;
      // full displacement は raster 必須（§27.12）→ live では skip。Fast* は region クランプ済みで適用可。
      if (
        DISPLACEMENT_EFFECT_TYPES.has(effect.type) &&
        !FAST_DISPLACEMENT_EFFECT_TYPES.has(effect.type)
      ) {
        continue;
      }
      const def = globalPluginRegistry.getEffectDef(effect.type);
      if (!def) continue;
      const piece = def.apply(effect.props, ctx);
      if (!piece || piece.kind === "raster") continue; // raster 系は live 不可
      this.pushFilterPiece(piece, tokens, svgFilters, `nfx-${obj.id}-${i++}`);
    }
    if (tokens.length === 0) return;
    const filterStr = tokens.join(" ");
    if (isAdj) {
      div.style.backdropFilter = filterStr;
      (div.style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter = filterStr;
    } else {
      div.style.filter = filterStr;
    }
    if (svgFilters.length === 0) return;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    const defs = document.createElementNS(SVG_NS, "defs");
    const filterEntry: Pick<ObjectEntry, "fxLayerW" | "fxLayerH" | "fxMaxDisplaceScale" | "fxUseBackdropDisplace"> = {
      fxLayerW: w,
      fxLayerH: h,
      fxMaxDisplaceScale: 0,
      fxUseBackdropDisplace: false,
    };
    for (const { id, primitives } of svgFilters) {
      defs.appendChild(this.createSvgFilterElement(id, primitives, filterEntry));
    }
    svg.appendChild(defs);
    div.insertBefore(svg, div.firstChild);
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
  previewVideoPlayback = false,
  exportVideoStep = false,
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
      const fit = props["fit"] as string | undefined;
      video.style.objectFit = (fit as "contain" | "cover" | "fill") ?? "contain";
      const assetId = props["asset"] as string | undefined;
      const src = assetId ? (imageCache?.getUrl(assetId) ?? "") : "";
      if (video.getAttribute("src") !== src) {
        video.src = src;
        // §11.4 mute は syncVideoElementTime がモード別に制御（再生中のみアンミュート）。
        // 初期状態は scrub 経路で muted=true になる。
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        video.controls = false;
      }
      const trimStart = (props["trimStart"] as number | undefined) ?? 0;
      const t = Math.max(0, (hostFrame - hostInPoint) / fps + trimStart / fps);
      // §11.4 内蔵音声の音量（resolve 済み scalar）。再生中のみ実際に鳴る（muted 制御は syncVideoElementTime）。
      const gain = typeof props["gain"] === "number" ? (props["gain"] as number) : 1;
      video.volume = Math.max(0, Math.min(1, gain));
      syncVideoElementTime(video, t, fps, { playbackMode: previewVideoPlayback, exportStep: exportVideoStep });
      if (exportVideoStep) {
        video.setAttribute(EXPORT_VIDEO_TARGET_ATTR, String(t));
      } else {
        video.removeAttribute(EXPORT_VIDEO_TARGET_ATTR);
      }
      // §11.4 preview/bundle warm-up 用に現フレームの target 時刻と assetId を記録（export attr とは別）。
      video.dataset.mafterTargetSec = String(t);
      if (assetId) video.dataset.mafterVideoAsset = assetId;
      else delete video.dataset.mafterVideoAsset;
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
    video.controls = false;
    video.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
    return video;
  }
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
  return el;
}
