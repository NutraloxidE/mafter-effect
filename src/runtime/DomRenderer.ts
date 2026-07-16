import { shouldForceOpaqueForDither } from "./ditherReveal";
import { DISPLACEMENT_EFFECT_TYPES, LIVE_DISPLACEMENT_EFFECT_TYPES } from "./effectSvg";
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
import { resolveVideoGainForFrame } from "./videoGainOnly";
import { applyTextEl, rgbaCss } from "./textRender";
import { parseGeom3DParams } from "./geom3d/geom3dParams";
import { applyGeom3DText, clearGeom3DCanvas, GEOM3D_CANVAS_CLASS } from "./geom3d/geom3dDomApply";
import { releaseGeom3DGl } from "./geom3d/geom3dGl";
import { buildMultiRingPathD, buildShapePathD, type ResolvedShapeVertex } from "./shapePath";
import { composeRings, multiPolygonToPathD } from "./shapePathBoolean";
import type { Ring } from "polygon-clipping";
import type { BooleanOp } from "../core/schema";
import { captureElementToCanvas } from "./rasterCapture";
import { canvasToRasterBuffer, rasterBufferToCanvas } from "./pixelSort";
import { processRasterChainAsync } from "./rasterProcessAsync";
import { applyFilterChainToBuffer } from "./effectRaster";
import { resolveEffectChain } from "./effectChain";
import { EXPORT_VIDEO_TARGET_ATTR, isSourceContinuousAcrossCut, primeVideoElement, syncVideoElementTime, waitForVideoFrame } from "./videoElementSync";
import {
  isVideoReadyAtTarget,
  type VideoClockSample,
} from "./playbackVideoSync";
import { normalizeFootageQuality, normalizePackedPreviewSelection, effectivePackedQuality } from "./footageQuality";
import { ensureVideosPrimed, peekVideoPrimed, type VideoPrimeTarget } from "./videoWarmupCache";
import {
  applyAlphaGenlock,
  compositeSplitAlpha,
  ensureSplitAlphaCompanion,
  findSplitAlphaVideo,
  mirrorSplitAlphaVideoState,
  releaseSplitAlphaGlCompositor,
  resetAlphaGenlockRate,
  scheduleSplitAlphaRedrawWhenReady,
  setSplitAlphaPresentation,
  SPLIT_ALPHA_CANVAS_CLASS,
  SPLIT_ALPHA_MASK_SCRATCH_CLASS,
  SPLIT_ALPHA_VIDEO_CLASS,
} from "./videoSplitAlpha";
import {
  compositePackedAlpha,
  ensurePackedAlphaCompanion,
  PACKED_ALPHA_CANVAS_CLASS,
  PACKED_ALPHA_MASK_SCRATCH_CLASS,
  releasePackedAlphaGlCompositor,
  schedulePackedAlphaRedrawWhenReady,
  setPackedAlphaPresentation,
} from "./videoPackedAlpha";
import { KeyedElementPool } from "./videoElementPool";
import {
  computeVideoLookaheadWarmupTargets,
  type VideoClipLookaheadInput,
} from "./videoLookaheadWarmup";
import {
  attachPresentedClock,
  detachPresentedClock,
  getPresentedMediaTimeSec,
} from "./videoPresentedClock";
import type { ExportChain, ExportLayer, NestedCompositeMeta, ExportTaggedElement } from "./exportComposite";
import type { EffectFilter } from "./plugin";
import type { BlendMode, TrackMatteMode } from "../core/schema";
import { isCssBlendMode } from "./blendCompose";
import { multiply, translation, type Mat4 } from "./mat4";
import {
  applyMatteSourceLayout,
  clearMatteSourceStyle,
  clearTrackMatteFillHost,
  ensureTrackMatteFillStructure,
  ensureTrackMatteResultCanvas,
  hideTrackMatteSources,
  markTrackMatteFillHost,
  showTrackMatteSourcesForTeardown,
} from "./trackMatteDom";
import { composeTrackMatteToCanvas } from "./trackMatteCapture";

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

/** §6.5b / §23.3b — 3D 層のみ cameraPre を掛け、2D 層は免除。 */
function objectWorldTransformWithCamera(cameraPre: Mat4 | null, obj: ResolvedObject): Mat4 {
  return cameraPre && obj.threeD === true
    ? multiply(cameraPre, obj.worldTransform)
    : obj.worldTransform;
}

/**
 * §5.4d 描画モードを div の style に反映する（トップレベル・ネスト comp 共用の純ヘルパ）。
 * 16種: `mix-blend-mode`（normal はクリア）。ラスター化ゼロのネイティブ合成。
 * 旧 dither 経路の mask 残留を防ぐため毎フレーム mask をクリアする。
 */
function setBlendModeStyle(el: HTMLElement, blend: BlendMode): void {
  const s = el.style;
  s.setProperty("mask-image", "");
  s.setProperty("-webkit-mask-image", "");
  s.mixBlendMode = isCssBlendMode(blend) ? blend : "";
}

interface ObjectEntry {
  div: HTMLDivElement;
  /** §5.4f トラックマット塗り時は inner（transform+content）。それ以外は div。 */
  contentRoot: HTMLDivElement;
  childSig: string; // component 型の連結。変化したら子を作り直す
  fxSig: string; // effect 型/順序/有効状態/props。変化したら svg defs を作り直す
  /** §27.5.1 syncSvgFilters が最後に defs へ書いた primitives の signature（svgRoot 併存確認込みで比較）。一致時は <defs> 再構築をスキップ。 */
  svgFiltersKey: string | null;
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
  /** §5.4f マット源（最終合成に出さない） */
  isTrackMatteSource: boolean;
  /** §5.4f トラックマット塗り（full-comp host + mask） */
  hasTrackMatte: boolean;
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
  /** §5.4f 現フレームにトラックマット塗りがあるか。 */
  private frameHasTrackMatte = false;

  /** §5.4f export / 経路判定。 */
  hasTrackMatteLayers(): boolean {
    return this.frameHasTrackMatte;
  }
  /** §5.4f matteId → mode。 */
  private trackMatteModeBySourceId = new Map<string, TrackMatteMode>();
  /** §5.4f fillId → matteId（可視マットのみ）。 */
  private trackMattePairByFillId = new Map<string, string>();
  /** §5.4f 非同期合成の in-flight。 */
  private trackMattePending = new Set<Promise<void>>();
  /** §5.4f ペア sig → 再合成スキップ。 */
  private trackMatteSigByFillId = new Map<string, string>();

  /**
   * §11.4 カット境界の `<video>` 要素再利用プール。key=assetId、value=離脱して空いた要素。
   * 同一動画の連結カットで境界レイヤーが入れ替わる際、破棄→新規生成（=再ロード/再デコード）の
   * 代わりに同一アセットの decode 済み要素を再利用してデコードギャップ（空フレーム・音の再初期化）を防ぐ。
   * preview/bundle 専用。export 経路は waitForVideoFrame がデコードを待つため決定論不変（INV-2）。
   */
  private videoPool = new KeyedElementPool<HTMLVideoElement>();
  /** §11.4 先読み warm-up でプールへ投入した <video>（scrub/停止時に明示破棄）。 */
  private lookaheadVideos = new Map<string, HTMLVideoElement>();
  /** 先読み判定用の comp 内 video クリップ一覧（PreviewPanel / BundlePlayer が注入）。 */
  private videoLookaheadClips: VideoClipLookaheadInput[] | null = null;

  // §7 HTML comp サポート: HtmlCompPlayer を注入（optional）。
  // mount 後に setHtmlPlayer() で差し替え可。
  private htmlPlayer: HtmlCompPlayer | null = null;

  /**
   * pixelStretch 動的解像度用の実効レンダースケール（デバイス解像度 / 表示解像度、>=1）。既定 1。
   * preview は zoom>1 のとき PreviewPanel が zoom×dpr を注入、bundle player は表示サイズから導出。
   * export(mp4/webm/PNG) は 1:1 なので既定 1 のまま。live filter の再ラスタ解像度に追随して
   * 変位マップを細分化するためだけに使う（scene 解決値・INV-2 には影響しない）。
   */
  private renderScale = 1;
  setRenderScale(scale: number): void {
    this.renderScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

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
  /** §5.5f 3D-extrude text の実 MVP 投影用。cameraPre と対の fov（度）。カメラなし時は null。 */
  private cameraFov: number | null = null;
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
  /** §11.4 映像先行ゲート: playback 中に video を pause（seek しない）。 */
  private playbackPauseForSync = false;
  private playbackRateForSync = 1;
  /** §11.7 bundle: true の間は playbackMode 中でも video を unmute しない（autoplay ポリシー回避）。 */
  private muteVideoPlayback = false;
  /**
   * fix-plan-v2plus (bundle 専用): 音声を別 <audio> 要素へ抽出済みの video オブジェクトID集合。
   * 該当する <video> は muteVideoPlayback の解除（gesture unmute）後も常時ミュートのまま
   * （音は BundleAudioClock の <audio> 要素側から鳴る＝二重音声防止）。null/未設定 = 全て通常挙動
   * （既存 export / editor preview はこのオプションを一切セットしないため無関係・無回帰）。
   */
  private persistentlyMutedVideoIds: ReadonlySet<string> | null = null;
  private previewLoop: { enabled: boolean; loopStart: Frame; loopEnd: Frame } = {
    enabled: false,
    loopStart: 0,
    loopEnd: 0,
  };
  private lastRenderedFrame: Frame | null = null;

  setPreviewRenderOptions(opts: {
    holdLastRaster?: boolean;
    forceAdjustmentRaster?: boolean;
    exportCompositeMode?: boolean;
    previewVideoPlayback?: boolean;
    exportVideoStep?: boolean;
    muteVideoPlayback?: boolean;
    persistentlyMutedVideoIds?: ReadonlySet<string> | null;
    loop?: { enabled: boolean; loopStart: Frame; loopEnd: Frame };
  }): void {
    if (opts.holdLastRaster !== undefined) this.holdLastRaster = opts.holdLastRaster;
    if (opts.forceAdjustmentRaster !== undefined) this.forceAdjustmentRaster = opts.forceAdjustmentRaster;
    if (opts.exportCompositeMode !== undefined) this.exportCompositeMode = opts.exportCompositeMode;
    if (opts.exportVideoStep !== undefined) this.exportVideoStep = opts.exportVideoStep;
    if (opts.muteVideoPlayback !== undefined) this.muteVideoPlayback = opts.muteVideoPlayback;
    if (opts.persistentlyMutedVideoIds !== undefined) this.persistentlyMutedVideoIds = opts.persistentlyMutedVideoIds;
    if (opts.loop !== undefined) this.previewLoop = opts.loop;
    if (opts.previewVideoPlayback !== undefined) {
      if (this.previewVideoPlayback && !opts.previewVideoPlayback) {
        this.playbackPauseForSync = false;
        this.playbackRateForSync = 1;
        this.pauseAllVideos();
        this.clearVideoLookaheadWarmups();
      }
      this.previewVideoPlayback = opts.previewVideoPlayback;
    }
  }

  /**
   * §11.4 双方向同期 — 映像先行時にマウント video を即 pause / 解除で play 再開。
   * seek はしない（旧 HW スタッタ対策 A）。
   */
  setPlaybackPauseForSync(pause: boolean): void {
    if (this.playbackPauseForSync === pause) return;
    this.playbackPauseForSync = pause;
    if (pause) {
      this.forEachVideoElement((video) => {
        try {
          if (!video.paused) video.pause();
        } catch {
          /* best-effort */
        }
      });
      return;
    }
    if (!this.previewVideoPlayback) return;
    this.forEachVideoElement((video) => {
      try {
        void video.play();
      } catch {
        /* best-effort */
      }
    });
  }

  setPlaybackRateForSync(rate: number): void {
    this.playbackRateForSync = Number.isFinite(rate) ? Math.max(0.96, Math.min(1.04, rate)) : 1;
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
    this.lastRenderedFrame = null;
  }

  renderFrame(scene: ResolvedScene, frame: Frame): void {
    if (!this.root) return;
    const previousRenderedFrame = this.lastRenderedFrame;
    const loopWrapFrame =
      this.previewVideoPlayback &&
      this.previewLoop.enabled &&
      previousRenderedFrame !== null &&
      previousRenderedFrame > frame &&
      frame === this.previewLoop.loopStart;

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
    this.frameHasTrackMatte = scene.objects.some((o) => o.trackMatte !== undefined);

    // camera / perspective (§6.5 / §6.5b)
    this.cameraPre = this.setupCameraRig(this.root, scene);
    this.cameraFov = scene.camera?.fov ?? null;

    // §5.4f: matteId → fill（マット源を fillHost 内へ載せるため）
    const fillByMatteId = new Map<string, ResolvedObject>();
    this.trackMatteModeBySourceId.clear();
    this.trackMattePairByFillId.clear();
    const visibleIds = new Set(scene.objects.map((o) => o.id));
    for (const obj of scene.objects) {
      if (obj.trackMatte) {
        fillByMatteId.set(obj.trackMatte.matteId, obj);
        this.trackMatteModeBySourceId.set(obj.trackMatte.matteId, obj.trackMatte.mode);
        if (visibleIds.has(obj.trackMatte.matteId)) {
          this.trackMattePairByFillId.set(obj.id, obj.trackMatte.matteId);
        }
      }
    }

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
        // 離脱オブジェクトごと div を破棄する前に split/packed alpha の GL compositor を明示解放
        // する（予算カウンタ・実 GL context のリーク防止。node.remove() だけでは解放されない）。
        this.releaseAlphaGlCompositorsUnder(entry.div);
        entry.div.remove();
        this.entries.delete(id);
        this.htmlPlayer?.unmountObject(id);
      }
    }

    const compW = scene.width;
    const compH = scene.height;

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
          contentRoot: div,
          childSig: "",
          fxSig: "",
          svgFiltersKey: null,
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
          isTrackMatteSource: false,
          hasTrackMatte: false,
        };
        this.entries.set(obj.id, entry);
      }
      entry.threeD = obj.threeD === true;
      entry.isTrackMatteSource = obj.isTrackMatteSource === true;
      entry.hasTrackMatte = obj.trackMatte !== undefined;

      // §5.4f: 塗りを先に host 化し、マット源は fillHost の子（destination-in/out）。
      if (obj.trackMatte) {
        if (entry.div.parentElement !== this.root) this.root.appendChild(entry.div);
        ensureTrackMatteFillStructure(entry.div, compW, compH);
      } else if (obj.isTrackMatteSource) {
        const fillObj = fillByMatteId.get(obj.id);
        const fillEntry = fillObj ? this.entries.get(fillObj.id) : undefined;
        if (fillEntry) {
          ensureTrackMatteFillStructure(fillEntry.div, compW, compH);
          if (entry.div.parentElement !== fillEntry.div) {
            fillEntry.div.appendChild(entry.div);
          }
        }
      } else if (entry.div.parentElement !== this.root) {
        this.root.appendChild(entry.div);
        clearMatteSourceStyle(entry.div);
      }

      this.applyObject(entry, obj, frame, compW, compH, loopWrapFrame);
    }

    // §11.4 入場処理で再利用されずプールに残った <video> を静音（離脱クリップの音漏れ防止）。
    this.quiescePooledVideos();

    // §11.4 異なるアセット間カット境界 — 再生中のみ in 点が近い clip を offscreen で先読み prime しプールへ投入。
    this.scheduleVideoLookaheadWarmup(frame);
    this.lastRenderedFrame = frame;
  }

  /**
   * §2.1/§2.2 — root 配下の split/packed alpha 合成 canvas の GL compositor を明示解放する
   * （予算カウンタ・実 GL context のリーク防止。呼び出し側で node.remove()/root.remove() する前に呼ぶ）。
   */
  private releaseAlphaGlCompositorsUnder(root: ParentNode): void {
    for (const canvas of root.querySelectorAll(`canvas.${SPLIT_ALPHA_CANVAS_CLASS}`)) {
      if (canvas instanceof HTMLCanvasElement) releaseSplitAlphaGlCompositor(canvas);
    }
    for (const canvas of root.querySelectorAll(`canvas.${PACKED_ALPHA_CANVAS_CLASS}`)) {
      if (canvas instanceof HTMLCanvasElement) releasePackedAlphaGlCompositor(canvas);
    }
    // §5.5f geom3d — オブジェクト削除時に per-layer WebGL context を明示解放（リーク防止）。
    for (const canvas of root.querySelectorAll(`canvas.${GEOM3D_CANVAS_CLASS}`)) {
      if (canvas instanceof HTMLCanvasElement) releaseGeom3DGl(canvas);
    }
  }

  /**
   * §11.4 離脱した entry の `<video>` を assetId 単位プールへ退避する（破棄しない）。
   * DOM から外すだけで **pause/mute はしない**: 同一フレームで入場レイヤーが同一アセットを
   * 再利用する場合に再生を止めると、内蔵音声が一瞬ミュート→再 seek→再 play で「急落→急上昇」
   * （ぶつ切り）になる。`<video>` は DOM から外しても再生継続する。再利用されず残った要素は
   * `quiescePooledVideos`（add ループ後）で pause+mute する＝遅延静音で音漏れも防ぐ。
   */
  private stashVideosToPool(entry: ObjectEntry): void {
    for (const el of entry.children) {
      if (!(el instanceof HTMLVideoElement)) continue;
      const assetId = el.dataset.mafterVideoAsset;
      if (!assetId) continue;
      if (el.parentNode) el.parentNode.removeChild(el);
      this.videoPool.stash(assetId, el);
    }
  }

  /** §11.4 同一アセットの空き `<video>` をプールから1つ取り出す（無ければ null）。 */
  private acquireVideoFromPool(assetId: string): HTMLVideoElement | null {
    const el = this.videoPool.acquire(assetId);
    if (!el) return null;
    for (const [objectId, tracked] of this.lookaheadVideos) {
      if (tracked === el) {
        this.lookaheadVideos.delete(objectId);
        break;
      }
    }
    return el;
  }

  /** §11.4 preview/bundle — comp 内 video クリップ一覧（先読み warm-up 判定用）。 */
  setVideoLookaheadClips(clips: VideoClipLookaheadInput[] | null): void {
    this.videoLookaheadClips = clips;
    if (!this.previewVideoPlayback) this.clearVideoLookaheadWarmups();
  }

  /**
   * §11.4 このフレームで再利用されずプールに残った `<video>` を pause+mute する（遅延静音）。
   * 退避時に止めないことで同一アセット連結カットの音声を連続させ、本当に離脱した（同一アセットの
   * 入場が無い）要素だけをここで静音する。冪等（既に停止済みは無害）。
   */
  private quiescePooledVideos(): void {
    for (const el of this.videoPool.peekAll()) {
      try {
        el.muted = true;
        if (!el.paused) el.pause();
      } catch {
        /* muted/pause best-effort */
      }
    }
  }

  private getActiveVideoAssetIds(): Set<string> {
    const ids = new Set<string>();
    for (const entry of this.entries.values()) {
      for (const el of entry.children) {
        if (el instanceof HTMLVideoElement) {
          const assetId = el.dataset.mafterVideoAsset;
          if (assetId) ids.add(assetId);
        }
      }
    }
    return ids;
  }

  private teardownVideoElement(el: HTMLVideoElement): void {
    detachPresentedClock(el);
    try {
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch {
      /* teardown best-effort */
    }
  }

  /** §11.4 先読み warm-up 要素をプールから除去して破棄（scrub/停止/dispose 用）。 */
  private clearVideoLookaheadWarmups(): void {
    for (const [objectId, el] of this.lookaheadVideos) {
      const assetId = el.dataset.mafterVideoAsset;
      if (assetId) this.videoPool.remove(assetId, el);
      this.teardownVideoElement(el);
      this.lookaheadVideos.delete(objectId);
    }
  }

  /**
   * §11.4 再生中 — in 点が近い upcoming clip 向けに offscreen <video> を生成・prime しプールへ stash。
   * export 経路は previewVideoPlayback=false のため非干渉（INV-2）。
   */
  private scheduleVideoLookaheadWarmup(frame: Frame): void {
    if (!this.previewVideoPlayback || this.exportVideoStep || !this.imageCache) return;
    const clips = this.videoLookaheadClips;
    if (!clips || clips.length === 0) return;
    const fps = this.currentComp?.fps ?? 30;
    const targets = computeVideoLookaheadWarmupTargets(frame, fps, clips, {
      activeAssetIds: this.getActiveVideoAssetIds(),
      loop: this.previewLoop,
    });
    const wanted = new Set(targets.map((t) => t.objectId));

    for (const objectId of [...this.lookaheadVideos.keys()]) {
      if (!wanted.has(objectId)) {
        const el = this.lookaheadVideos.get(objectId);
        if (el) {
          const assetId = el.dataset.mafterVideoAsset;
          if (assetId) this.videoPool.remove(assetId, el);
          this.teardownVideoElement(el);
        }
        this.lookaheadVideos.delete(objectId);
      }
    }

    for (const t of targets) {
      if (t.reason !== "loop" && this.entries.has(t.objectId)) continue;
      if (this.lookaheadVideos.has(t.objectId)) continue;
      if (this.videoPool.has(t.assetId)) continue;

      const clip = clips.find((c) => c.objectId === t.objectId);
      const quality = normalizeFootageQuality(clip?.footageQuality);
      // §16.2b: 本経路は exportVideoStep===false のときのみ実行される（L547）ので、packed 資産は
      // 常に effectivePackedQuality(previewSelection, { exportStep: false, exportQuality }) と
      // 同じ tier を先読みする（メイン描画側 updateComponentEl と quality が食い違うと、
      // prime した URL が使われずカット到達時に無駄になる。Same as Export Quality 選択時は
      // clip.packedExportQuality と対で解決する）。
      const isPackedAsset = this.imageCache.getPackedAlphaLayout(t.assetId) != null;
      const effQuality = isPackedAsset
        ? effectivePackedQuality(normalizePackedPreviewSelection(clip?.footageQuality), {
            exportStep: false,
            exportQuality: normalizeFootageQuality(clip?.packedExportQuality),
          })
        : quality;
      const src = this.imageCache.getUrlForQuality(t.assetId, effQuality) ?? "";
      if (!src) continue;

      const video = document.createElement("video");
      video.controls = false;
      video.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = src;
      video.dataset.mafterVideoAsset = t.assetId;
      video.dataset.mafterTargetSec = String(t.targetSec);
      video.dataset.mafterLookaheadObjectId = t.objectId;

      this.lookaheadVideos.set(t.objectId, video);
      this.videoPool.stash(t.assetId, video);

      void ensureVideosPrimed([
        {
          assetId: t.assetId,
          targetSec: t.targetSec,
          fps,
          prime: () => primeVideoElement(video, t.targetSec, fps),
        },
      ]).catch(() => {
        /* best-effort */
      });
    }
  }

  private swapVideoForLoopWarmup(
    entry: ObjectEntry,
    childIndex: number,
    props: Record<string, unknown>,
    frame: Frame,
    hostInPoint: number,
    fps: number,
  ): HTMLVideoElement | null {
    const current = entry.children[childIndex];
    if (!(current instanceof HTMLVideoElement)) return null;
    const assetId = typeof props["asset"] === "string" ? props["asset"] : undefined;
    if (!assetId) return null;
    const trimStart = (props["trimStart"] as number | undefined) ?? 0;
    const targetSec = Math.max(0, (frame - hostInPoint) / fps + trimStart / fps);
    const candidate = this.acquireVideoFromPool(assetId);
    if (!candidate) return null;
    if (!isVideoReadyAtTarget(candidate, targetSec, fps)) {
      this.videoPool.stash(assetId, candidate);
      const lookaheadObjectId = candidate.dataset.mafterLookaheadObjectId;
      if (lookaheadObjectId) this.lookaheadVideos.set(lookaheadObjectId, candidate);
      return null;
    }

    try {
      current.muted = true;
      if (!current.paused) current.pause();
    } catch {
      /* pause best-effort */
    }
    if (current.parentNode) current.parentNode.replaceChild(candidate, current);
    else entry.contentRoot.appendChild(candidate);
    entry.children[childIndex] = candidate;
    this.teardownVideoElement(current);
    return candidate;
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

  /** §27.1 raster — 非同期 raster effect 完了を待つ（export 用・INV-2）。トラックマット合成も含む。 */
  async flushRasterEffects(): Promise<void> {
    await Promise.all([
      this.rasterPending.size > 0 ? Promise.all([...this.rasterPending]) : Promise.resolve(),
      this.flushTrackMattes(),
    ]);
  }

  /** §5.4f — canvas applyTrackMatte 合成の完了を待つ。 */
  async flushTrackMattes(): Promise<void> {
    if (this.trackMattePending.size === 0) return;
    await Promise.all([...this.trackMattePending]);
  }

  /**
   * §5.4f 正準: fill / matte をラスタ → applyTrackMatte → result canvas。
   * 画面上は result のみ表示（fillInner / matte は visibility:hidden）。
   */
  private scheduleTrackMatteCompose(
    obj: ResolvedObject,
    entry: ObjectEntry,
    frame: Frame,
    compW: number,
    compH: number,
  ): void {
    if (!obj.trackMatte) return;
    const fillInner = entry.contentRoot;
    const matteId = this.trackMattePairByFillId.get(obj.id);
    const matteEl = matteId ? (this.entries.get(matteId)?.div ?? null) : null;
    const mode = obj.trackMatte.mode;
    const result = ensureTrackMatteResultCanvas(entry.div, compW, compH);

    const perspective = this.root?.style.perspective ?? "";
    const perspectiveOrigin = this.root?.style.perspectiveOrigin || "50% 50%";
    const runKey = `${obj.id}|${matteId ?? ""}|${mode}|${frame}`;
    this.trackMatteSigByFillId.set(obj.id, runKey);

    const work = (async () => {
      try {
        await composeTrackMatteToCanvas(
          fillInner,
          matteEl,
          mode,
          compW,
          compH,
          result,
          perspective,
          perspectiveOrigin,
        );
        // 古いフレームの完了が新しい結果を上書きしない
        if (this.trackMatteSigByFillId.get(obj.id) !== runKey) return;
        hideTrackMatteSources(fillInner, matteEl);
      } catch (err) {
        console.warn("[trackMatte] compose failed", obj.id, err);
      }
    })();

    this.trackMattePending.add(work);
    void work.finally(() => {
      this.trackMattePending.delete(work);
    });
  }

  /** export 前に video seek / decode 完了を待つ（foreignObject は video を描けない）。 */
  async flushVideoFrames(timeoutMs?: number): Promise<void> {
    if (!this.root) return;
    const videos = [...this.root.querySelectorAll("video")];
    if (videos.length === 0) return;
    await Promise.all(videos.map((v) => {
      const raw = v.getAttribute(EXPORT_VIDEO_TARGET_ATTR);
      const target = raw !== null && raw !== "" ? Number(raw) : undefined;
      return waitForVideoFrame(v, Number.isFinite(target) ? target : undefined, timeoutMs);
    }));
    for (const v of videos) {
      if (v.classList.contains(SPLIT_ALPHA_VIDEO_CLASS)) continue;
      if (findSplitAlphaVideo(v)) {
        // ensureSplitAlphaCompanion は既存要素があれば作成せず引き当てるだけ（冪等）。
        // GL compositor のキャッシュ・broken 判定込みで companion を再取得する。
        const companion = ensureSplitAlphaCompanion(v);
        compositeSplitAlpha(v, companion.alphaVideo, companion.canvas, companion.maskScratch);
        continue;
      }
      const assetId = v.dataset.mafterVideoAsset;
      const packedLayout = assetId ? this.imageCache?.getPackedAlphaLayout(assetId) ?? null : null;
      if (packedLayout) {
        const companion = ensurePackedAlphaCompanion(v);
        compositePackedAlpha(v, companion.canvas, companion.maskScratch, packedLayout);
      }
    }
  }

  /**
   * §11.5.2 declick を renderGate から独立させるための軽量音声適用（bundle 専用）。
   * resolveVideoGainForFrame は transform/effect/DOM に触れないため、adaptiveRenderBudget が
   * 視覚描画を間引いているフレームでも毎フレーム呼べるコストで、ループ継ぎ目の fade-out/in が
   * video.volume に確実に反映される（renderFrame() 呼び出しの有無と無関係）。マウント済み要素
   * だけを更新し、要素の生成・破棄・seek・muted 制御には一切触れない（それらは renderFrame の
   * 責務のまま）。
   */
  applyAudioForFrame(comp: TimelineComposition, frame: Frame, evaluator?: ExpressionEvaluator): void {
    if (!this.root) return;
    const gains = resolveVideoGainForFrame(comp, frame, evaluator);
    if (gains.size === 0) return;
    this.forEachVideoElement((video, objectId) => {
      const gain = gains.get(objectId);
      if (gain === undefined) return;
      video.volume = gain;
    });
  }

  /** §11.4 preview/bundle warm-up — マウント済み video 要素を列挙（ネスト comp 内も含む）。 */
  forEachVideoElement(cb: (video: HTMLVideoElement, objectId: string) => void): void {
    if (!this.root) return;
    for (const v of this.root.querySelectorAll("video")) {
      if (v.classList.contains(SPLIT_ALPHA_VIDEO_CLASS)) continue;
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
      const alpha = findSplitAlphaVideo(video);
      if (alpha) {
        targets.push({
          assetId: `${assetId}:alpha`,
          targetSec,
          fps,
          prime: () => primeVideoElement(alpha, targetSec, fps, timeoutMs),
        });
      }
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
   * §11.4 Play 直前 barrier — primed キャッシュを信用せず、実要素を現 target へ seek+ready。
   * 既に半フレーム以内かつ data ready なら pause/seek しない（毎 Play の音声ブリップ防止）。
   * lookahead 要素は root 外のため対象外。
   */
  async syncMountedVideosForPlay(fps: number, timeoutMs?: number): Promise<boolean> {
    if (!this.root) return true;
    const jobs: Promise<boolean>[] = [];
    this.forEachVideoElement((video) => {
      const rawT = video.dataset.mafterTargetSec;
      if (rawT === undefined) return;
      const targetSec = Number(rawT);
      if (!Number.isFinite(targetSec)) return;
      if (isVideoReadyAtTarget(video, targetSec, fps)) return;
      jobs.push(primeVideoElement(video, targetSec, fps, timeoutMs));
      const alpha = findSplitAlphaVideo(video);
      if (alpha && !isVideoReadyAtTarget(alpha, targetSec, fps)) {
        jobs.push(primeVideoElement(alpha, targetSec, fps, timeoutMs));
      }
    });
    if (jobs.length === 0) return true;
    const results = await Promise.all(jobs);
    return results.every(Boolean);
  }

  /**
   * §11.4 playback hold 用 — マウント済み表示中 video の target / currentTime を列挙。
   * lookahead（root 外）は含まれない。適格判定は playbackVideoSync 側。
   */
  sampleMountedVideoClocks(): VideoClockSample[] {
    const samples: VideoClockSample[] = [];
    const pushSample = (video: HTMLVideoElement, role: "primary" | "companion"): void => {
      const rawT = video.dataset.mafterTargetSec;
      if (rawT === undefined) return;
      const targetSec = Number(rawT);
      if (!Number.isFinite(targetSec)) return;
      const duration = Number(video.duration);
      samples.push({
        targetSec,
        currentTimeSec: video.currentTime,
        presentedSec: getPresentedMediaTimeSec(video) ?? undefined,
        paused: video.paused,
        ended: video.ended,
        error: video.error !== null,
        duration: Number.isFinite(duration) ? duration : Number.POSITIVE_INFINITY,
        role,
      });
    };
    this.forEachVideoElement((video) => {
      pushSample(video, "primary");
      // §16.2 split alpha: color と alpha は独立デコード（ビットレート差が大きい）ので個別に
      // サンプルするが、companion（見えない mask ストリーム）は role: "companion" として区別する。
      // comp 全体の holdTimeline/pauseVideo 判定（呼び出し側で primary のみに絞る）からは除外し、
      // per-element の resync（syncVideoElementTime）にのみ委ねる。
      const alpha = findSplitAlphaVideo(video);
      if (alpha) pushSample(alpha, "companion");
    });
    return samples;
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
    this.clearVideoLookaheadWarmups();
    // §11.4 プールに退避した <video> も明示破棄（src 解放・リーク防止）。
    for (const el of this.videoPool.drain()) {
      this.teardownVideoElement(el);
    }
    if (this.root) {
      this.releaseAlphaGlCompositorsUnder(this.root);
      this.root.remove();
      this.root = null;
    }
    this.entries.clear();
    this.currentComp = null;
    this.lastRenderedFrame = null;
  }

  private pauseAllVideos(): void {
    for (const entry of this.entries.values()) {
      for (const el of entry.children) {
        if (el instanceof HTMLVideoElement) {
          // §11.4 停止時はミュートも戻す（次のスクラブ前の音漏れ防止）。
          try {
            el.playbackRate = 1;
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
    // §11.4 プールに退避した（再生継続中かもしれない）<video> も停止・静音する。
    this.quiescePooledVideos();
  }

  private applyObject(
    entry: ObjectEntry,
    obj: ResolvedObject,
    frame: Frame,
    compW = this.currentComp?.width ?? 0,
    compH = this.currentComp?.height ?? 0,
    loopWrapFrame = false,
  ): void {
    // §6.5b/§5.4b 3D 層（threeD）のみカメラ view を per-object で焼く（root perspective を受けて
    // dolly/zoom が効く）。2D 層は素の worldTransform = カメラ免除（AE 準拠, z=0 で perspective 無歪み）。
    const xform = objectWorldTransformWithCamera(this.cameraPre, obj);
    const opacity = shouldForceOpaqueForDither(obj.effects, obj.opacity)
      ? "1"
      : String(obj.opacity);

    if (obj.isTrackMatteSource) {
      // §5.4f: fillHost 内に置きキャプチャ専用（画面には出さない）。
      entry.contentRoot = entry.div;
      entry.blendMode = "normal";
      applyMatteSourceLayout(entry.div, mat4ToCss(xform), Number(opacity));
    } else if (obj.trackMatte) {
      // §5.4f: full-comp host + inner + result canvas（正準 = applyTrackMatte）。
      const inner = ensureTrackMatteFillStructure(entry.div, compW, compH);
      entry.contentRoot = inner;
      inner.style.transform = mat4ToCss(xform);
      inner.style.opacity = opacity;
      entry.div.style.opacity = "1";
      entry.div.style.zIndex = String(Math.round(obj.zOrder * BASE_Z));
      this.applyBlendMode(entry, obj.blendMode);
      markTrackMatteFillHost(entry.div, obj.id);
      ensureTrackMatteResultCanvas(entry.div, compW, compH);
    } else {
      entry.contentRoot = entry.div;
      // §5.4f 後始末を先に行う（matte source 用の zIndex 等を消してから現在値を設定する。
      // 逆順だと clearMatteSourceStyle の zIndex="" が直後の設定を上書きしてしまう）。
      clearTrackMatteFillHost(entry.div);
      clearMatteSourceStyle(entry.div);
      entry.div.style.transform = mat4ToCss(xform);
      entry.div.style.opacity = opacity;
      entry.div.style.zIndex = String(Math.round(obj.zOrder * BASE_Z));
      this.applyBlendMode(entry, obj.blendMode);
      this.trackMatteSigByFillId.delete(obj.id);
      // host 構造から通常へ戻るとき inner を畳む（マット子は先に外へ）
      const inner = entry.div.querySelector(":scope > [data-track-matte-inner]") as HTMLDivElement | null;
      if (inner) {
        for (const child of [...entry.div.children]) {
          if (child instanceof HTMLElement && child.dataset.objectId && this.root) {
            this.root.appendChild(child);
            clearMatteSourceStyle(child);
            showTrackMatteSourcesForTeardown(inner, child);
          }
        }
        showTrackMatteSourcesForTeardown(inner, null);
        while (inner.firstChild) entry.div.appendChild(inner.firstChild);
        inner.remove();
        entry.contentRoot = entry.div;
        entry.div.style.isolation = "";
      }
    }

    if (obj.isAdjustment) {
      const w = compW;
      const h = compH;
      entry.div.style.width = `${w}px`;
      entry.div.style.height = `${h}px`;
      entry.div.style.background = "transparent";
      entry.div.style.pointerEvents = "none";
    } else if (!obj.trackMatte && !obj.isTrackMatteSource) {
      entry.div.style.width = "";
      entry.div.style.height = "";
      entry.div.style.background = "";
    }

    const contentRoot = entry.contentRoot;
    const sig = obj.components.map((c) => c.type).join("|");
    // §11.4 このフレームで entry の子要素を作り直した＝カット境界（プールから別クリップ用に
    // <video> を再取得した可能性がある）。video の resync を半フレーム精度に強制する合図として使う。
    const childrenRebuilt = sig !== entry.childSig;
    if (childrenRebuilt) {
      // html comp が含まれていた場合は player のエントリも解放してから作り直す
      if (entry.childSig.split("|").includes("html")) {
        this.htmlPlayer?.unmountObject(obj.id);
      }
      // 構造が変わった: 子を作り直す（svgRoot は host に残す）
      const svgRoot = entry.svgRoot;
      for (const child of [...contentRoot.childNodes]) {
        if (child !== svgRoot) child.parentNode?.removeChild(child);
      }
      if (svgRoot && svgRoot.parentElement !== entry.div) {
        entry.div.appendChild(svgRoot);
      }
      entry.children = obj.components.map((c) => {
        // §11.4 video は同一アセットの decode 済み要素をプールから再利用（境界の空フレーム回避）。
        const assetId = c.type === "video" ? (c.props["asset"] as string | undefined) : undefined;
        const el =
          assetId && assetId !== ""
            ? (this.acquireVideoFromPool(assetId) ?? createComponentEl("video"))
            : createComponentEl(c.type);
        contentRoot.appendChild(el);
        return el;
      });
      entry.childSig = sig;
    }

    // props を in-place で更新（<img> src は変化時のみ → 再読込しない）
    obj.components.forEach((c, i) => {
      let el = entry.children[i];
      let forceSeek = childrenRebuilt;
      if (el) {
        const hostInPoint = (c.props["_hostInPoint"] as number | undefined) ?? 0;
        const fps = this.currentComp?.fps ?? 30;
        if (loopWrapFrame && c.type === "video" && el instanceof HTMLVideoElement) {
          const swapped = this.swapVideoForLoopWarmup(entry, i, c.props, frame, hostInPoint, fps);
          if (swapped) el = swapped;
          forceSeek = true;
        }
        const persistentlyMuted = this.persistentlyMutedVideoIds?.has(obj.id) ?? false;
        // §6.5b: 2D 層（threeD=false）はカメラ免除 — CSS 側の objectWorldTransformWithCamera と同じ規約を
        // GL の mvp にも適用する（でないと 3D OFF の extrude text だけカメラに捕まる）。
        const use3D = obj.threeD === true;
        const geom3dCamera = {
          cameraPre: use3D ? this.cameraPre : null,
          fov: use3D ? this.cameraFov : null,
          world: obj.worldTransform,
          compW,
          compH,
        };
        updateComponentEl(el, c.type, c.props, this.textQuality, this.fontCache, this.imageCache, frame, hostInPoint, fps, this.previewVideoPlayback, this.exportVideoStep, forceSeek, this.playbackPauseForSync, this.muteVideoPlayback, this.playbackRateForSync, persistentlyMuted, geom3dCamera);
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

    // §5.4f: 塗り+マットの canvas 合成をスケジュール（flushTrackMattes / flushRasterEffects で待つ）。
    if (obj.trackMatte) {
      this.scheduleTrackMatteCompose(obj, entry, frame, compW, compH);
    }
  }

  /**
   * §5.4d 描画モードを CSS に反映する（16 種は mix-blend-mode、normal はクリア）。
   */
  private applyBlendMode(entry: ObjectEntry, blend: BlendMode): void {
    entry.blendMode = blend;
    // マット源は destination-in/out を持つので layer blendMode を載せない。
    if (entry.isTrackMatteSource) return;
    setBlendModeStyle(entry.div, blend);
  }

  /** §5.4d capture — comp 内に CSS mix-blend を持つレイヤーがあるか（Canvas 合成要否判定）。 */
  hasCssBlendLayers(): boolean {
    for (const entry of this.entries.values()) {
      if (isCssBlendMode(entry.blendMode)) return true;
    }
    return false;
  }

  /** §5.4d capture — z 順（昇順）のレイヤー div と描画モードを返す。Canvas 合成用。マット源は除外。 */
  getCompositeLayers(): { div: HTMLElement; blendMode: BlendMode }[] {
    const layers = [...this.entries.values()]
      .filter((e) => !e.isTrackMatteSource)
      .map((e) => ({
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

  /**
   * §6.5b / §28 — 現フレームに threeD レイヤーがあるか。
   * root 一括 foreignObject capture（高速経路）は 3D 層を潰すため、true のときは
   * exportComposite の per-layer perspective capture を使う。
   */
  hasThreeDContent(): boolean {
    for (const e of this.entries.values()) {
      if (e.threeD && !e.isAdjustment) return true;
    }
    return false;
  }

  /** §27.4.1 — exportComposite 用の z 昇順レイヤ列。調整レイヤーは effect chain 付き。マット源は除外。 */
  getExportLayers(): ExportLayer[] {
    const layers = [...this.entries.values()]
      .filter((e) => !e.isTrackMatteSource)
      .map((e) => ({
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
    const layerOpacity = obj.opacity;
    const ctx = obj.isAdjustment
      ? { width: compW, height: compH, frame, layerOpacity, renderScale: this.renderScale }
      : {
          width: layerW || entry.div.offsetWidth || compW,
          height: layerH || entry.div.offsetHeight || compH,
          frame,
          layerOpacity,
          renderScale: this.renderScale,
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
      entry.svgFiltersKey = null;
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
      // （auto_raster_mp4）。mosaicLite は direct foreignObject capture が空白化するため、
      // export composite の通常レイヤーだけ同じ SVG filter を焼いてから合成する。
      const forceMosaicLiteExportCapture =
        this.exportCompositeMode &&
        obj.isAdjustment !== true &&
        (obj.effects ?? []).some((effect) => effect.enabled && effect.type === "mosaicLite");
      const needsCapture = forceMosaicLiteExportCapture || needsSvgDisplaceCapture({
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
    const isAdjustment = obj.isAdjustment === true;
    const filterTarget = !isAdjustment && entry.hasTrackMatte ? entry.contentRoot : entry.div;
    // §5.4f: トラックマット塗りは mask を host に残し、effect filter は inner（contentRoot）へ。
    // この style 代入は毎フレーム無条件で実行する — 非トラックマット時は毎フレーム走る
    // clearMatteSourceStyle（トラックマット離脱後始末）が entry.div.style.filter を "" にリセットするため、
    // ここをキャッシュでスキップすると filter が消えたまま戻らない（実機で確認済み）。
    // 代入自体は安いので無条件実行のコストは無視できる。重い再構築（<defs>/feImage 再デコード）
    // だけを syncSvgFilters 側でキャッシュする。
    entry.div.style.filter = "";
    if (entry.contentRoot !== entry.div) entry.contentRoot.style.filter = "";
    if (isAdjustment) {
      entry.div.style.backdropFilter = filterStr;
      (entry.div.style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter = filterStr;
    } else {
      entry.div.style.backdropFilter = "";
      (entry.div.style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter = "";
      filterTarget.style.filter = filterStr;
    }
    this.syncSvgFilters(entry, svgFilters);
  }

  private syncSvgFilters(
    entry: ObjectEntry,
    svgFilters: { id: string; primitives: string }[],
  ): void {
    if (svgFilters.length > 0) {
      // defs の中身（primitives）は props/width/height のみに依存する純関数の出力。
      // 前回と完全一致なら再構築しない — feImage 埋め込み SVG を持つ mosaicLite 等は
      // ブラウザ側の再デコードコストが大きく、毎フレームの無条件再構築は無駄。
      const svgKey = svgFilters.map((f) => f.id + " " + f.primitives).join("");
      if (entry.svgRoot && entry.svgFiltersKey === svgKey) {
        return;
      }
      entry.svgFiltersKey = svgKey;
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
    } else {
      entry.svgFiltersKey = null;
      if (entry.svgRoot) {
        entry.svgRoot.remove();
        entry.svgRoot = null;
      }
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

  // §5.5f/§23.3b — ネスト comp コンテナごとの「持ち越す el」（key → el）。
  // 毎フレーム作り直すと WebGL context が枯渇する geom3d text と、再帰コンテナのみを保持する。
  // container が捨てられれば Map ごと GC される（WeakMap）。
  private nestedElReuse = new WeakMap<HTMLElement, Map<string, HTMLElement>>();

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

    // 毎フレーム再描画（Phase 1 簡易実装。html/plugin comp は対象外）。
    // §5.5f: ただし GL コンテキストを抱える el（geom3d text・再帰コンテナ）だけは前フレームの
    // 実体を key で持ち越す。innerHTML="" で作り直すと canvas ごと WebGL context が毎フレーム
    // 生まれ、Chrome の同時コンテキスト上限（~16）を数十フレームで超えて
    // "Too many active WebGL contexts. Oldest context will be lost." → 3D が消える。
    const prevEls = this.nestedElReuse.get(container) ?? new Map<string, HTMLElement>();
    const nextEls = new Map<string, HTMLElement>();
    container.innerHTML = "";
    // §23.3d export — この comp（再帰的に）に調整レイヤーがあれば子座標系で1枚へ確定する必要がある。
    let needsComposite = false;
    for (const obj of childScene.objects) {
      const div = document.createElement("div");
      const xform = objectWorldTransformWithCamera(cameraPre, obj);
      const isAdj = obj.isAdjustment === true;
      const nestedOpacity = shouldForceOpaqueForDither(obj.effects, obj.opacity)
        ? "1"
        : String(obj.opacity);
      if (isAdj) {
        // §23.3d: 調整レイヤーは comp 全面の空 div とし、effect を backdrop-filter で背後へ効かせる。
        // コンテンツ component は描かない（背後を覆わないため）。
        div.style.cssText = `position:absolute;top:0;left:0;transform-origin:0 0;transform:${mat4ToCss(xform)};opacity:${nestedOpacity};z-index:${Math.round(obj.zOrder * BASE_Z)};width:${childComp.width}px;height:${childComp.height}px;background:transparent;pointer-events:none`;
      } else {
        div.style.cssText = `position:absolute;top:0;left:0;transform-origin:0 0;transform:${mat4ToCss(xform)};opacity:${nestedOpacity};z-index:${Math.round(obj.zOrder * BASE_Z)}`;
        for (const [ci, c] of obj.components.entries()) {
          // 型まで含めた key。components の並び替え・型変更で誤再利用しない。
          const reuseKey = `${obj.id}:${ci}:${c.type}`;
          if (c.type === "comp") {
            // ネストされた comp は再帰描画（深度制限付き）
            const nestedCompId = c.props["compId"] as string | undefined;
            const nestedComp = this.pendingTimelineComps?.get(nestedCompId ?? "");
            if (nestedComp) {
              // コンテナを持ち越す＝深い階層（depth 2+）の geom3d canvas も生き延びる。
              // renderNestedComp は container の style/children を毎フレーム全書き換えするため再利用は無害。
              const innerEl = prevEls.get(reuseKey) ?? document.createElement("div");
              nextEls.set(reuseKey, innerEl);
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
          // text/video だけ el を持ち越す。text は geom3d canvas（WebGL context）の宿主。
          // video は毎フレーム新規要素にすると <video> の decode/再生状態が全て失われ、
          // 再生が一切進まなくなる（トップレベルの acquireVideoFromPool 相当をネストにも適用）。
          // updateComponentEl が中身を毎フレーム全書き換えする（text: 3D=applyGeom3DText /
          // 2D=clearGeom3DCanvas+applyTextEl、video: src/seek/syncVideoElementTime）ため、
          // 再利用しても描画結果は変わらない。他型は従来どおり毎フレーム新規。
          const persistsAcrossFrames = c.type === "text" || c.type === "video";
          const el = (persistsAcrossFrames ? prevEls.get(reuseKey) : undefined) ?? createComponentEl(c.type);
          if (persistsAcrossFrames) nextEls.set(reuseKey, el);
          const hostInPoint = (c.props["_hostInPoint"] as number | undefined) ?? 0;
          // §16.2 split alpha: ensureSplitAlphaCompanion は video.parentElement に依存するため、
          // updateComponentEl より先に append する（順序を変えると nested comp 内の split alpha
          // video が「parent なし」で例外を投げる）。
          div.appendChild(el);
          const nestedPersistentlyMuted = this.persistentlyMutedVideoIds?.has(obj.id) ?? false;
          // §5.5f/§23.3b: ネスト comp でも 3D-extrude text を実投影する。カメラ・comp 寸法は
          // 「子 comp のもの」を渡す — precomp 内の 3D は子の座標系で解決され、外側の変換は
          // container 側の CSS transform が担う（AE collapse OFF 相当）。
          const nestedGeom3dCamera = {
            cameraPre: obj.threeD === true ? cameraPre : null,
            fov: obj.threeD === true ? (childScene.camera?.fov ?? null) : null,
            world: obj.worldTransform,
            compW: childComp.width,
            compH: childComp.height,
          };
          updateComponentEl(el, c.type, c.props, this.textQuality, this.fontCache, this.imageCache, childFrame, hostInPoint, childComp.fps, this.previewVideoPlayback, this.exportVideoStep, false, this.playbackPauseForSync, this.muteVideoPlayback, this.playbackRateForSync, nestedPersistentlyMuted, nestedGeom3dCamera);
        }
      }
      container.appendChild(div);
      // §23.3a: トップレベルと挙動を揃える（ラスタ無し・append 後に実測サイズで filter region 決定）。
      setBlendModeStyle(div, obj.blendMode);

      if (this.exportCompositeMode) {
        // §23.3d export — backdrop-filter は foreignObject で落ちるため、調整は live に立てず
        // 解決済み chain をレイヤメタに保存し、exportComposite が子座標系で背面 master へ焼く。
        let exportChain: ExportChain | null = null;
        if (isAdj) {
          const ctx = {
            width: childComp.width,
            height: childComp.height,
            frame: childFrame,
            layerOpacity: obj.opacity,
          };
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

    // 今フレーム使われなかった持ち越し el（レイヤー削除・3D OFF・型変更）は明示的に解放する。
    for (const [key, el] of prevEls) {
      if (nextEls.get(key) === el) continue;
      this.releaseAlphaGlCompositorsUnder(el);
      if (el instanceof HTMLVideoElement) this.teardownVideoElement(el);
    }
    this.nestedElReuse.set(container, nextEls);

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
    const ctx = { width: w, height: h, frame, layerOpacity: obj.opacity, renderScale: this.renderScale };
    const tokens: string[] = [];
    const svgFilters: { id: string; primitives: string }[] = [];
    let i = 0;
    for (const effect of effects) {
      if (!effect.enabled) continue;
      // full displacement は raster 必須（§27.12）→ live では skip。LIVE セットは region クランプ済みで適用可。
      if (
        DISPLACEMENT_EFFECT_TYPES.has(effect.type) &&
        !LIVE_DISPLACEMENT_EFFECT_TYPES.has(effect.type)
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

/**
 * split⇄packed（あるいは両方→none）のモード切替時、直前のモードの companion 要素・GL compositor が
 * 残らないよう「keep 以外」の残骸を消す。asset 差し替えで alphaMode が split→packed や packed→split
 * に変わっても、旧 companion のデコード継続・二重表示・GL 予算リークが起きないようにする。
 */
function clearAlphaRemnants(parent: ParentNode, keep: "split" | "packed" | "none"): void {
  if (keep !== "split") {
    for (const node of parent.querySelectorAll(
      `video.${SPLIT_ALPHA_VIDEO_CLASS}, canvas.${SPLIT_ALPHA_CANVAS_CLASS}, canvas.${SPLIT_ALPHA_MASK_SCRATCH_CLASS}`,
    )) {
      if (node instanceof HTMLCanvasElement && node.classList.contains(SPLIT_ALPHA_CANVAS_CLASS)) {
        releaseSplitAlphaGlCompositor(node);
      }
      node.remove();
    }
  }
  if (keep !== "packed") {
    for (const node of parent.querySelectorAll(
      `canvas.${PACKED_ALPHA_CANVAS_CLASS}, canvas.${PACKED_ALPHA_MASK_SCRATCH_CLASS}`,
    )) {
      if (node instanceof HTMLCanvasElement && node.classList.contains(PACKED_ALPHA_CANVAS_CLASS)) {
        releasePackedAlphaGlCompositor(node);
      }
      node.remove();
    }
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
  forceSeek = false,
  pauseForSync = false,
  muteVideoPlayback = false,
  playbackRateForSync = 1,
  /** fix-plan-v2plus (bundle 専用): 音声抽出済み video は gesture unmute 後も常時ミュート維持。 */
  persistentlyMuted = false,
  /** §5.5f 3D-extrude text の実 MVP 投影に必要なカメラ/world/comp サイズ（text 以外は未使用）。 */
  geom3dCamera: { cameraPre: Mat4 | null; fov: number | null; world: Mat4; compW: number; compH: number } | null = null,
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
      const kind = props["kind"] as string | undefined;
      // §5.5d: kind="merge" は他レイヤー参照の Boolean 合成結果（Illustrator Pathfinder 相当）を描画する。
      const usesSvgPath = kind === "path" || kind === "merge";
      if (usesSvgPath) {
        // §5.5c/§5.5d: vertices（または merge 合成）ベースの自由パス。CSS box は使わず
        // 子 <svg><path> で描画する（既存 rect/ellipse の box style を残すと path 切替後も
        // 背景が透けて残るため明示的に解除）。
        el.style.width = "0px";
        el.style.height = "0px";
        el.style.background = "transparent";
        el.style.borderRadius = "0";
        let svg = el.querySelector("svg[data-mafter-shape-path]") as SVGSVGElement | null;
        if (!svg) {
          svg = document.createElementNS(SVG_NS, "svg") as unknown as SVGSVGElement;
          svg.dataset.mafterShapePath = "1";
          svg.style.cssText = "position:absolute;top:0;left:0;overflow:visible;pointer-events:none";
          const pathEl = document.createElementNS(SVG_NS, "path");
          svg.appendChild(pathEl);
          el.appendChild(svg);
        }
        const pathEl = svg.querySelector("path")!;
        const rings = props["rings"] as ResolvedShapeVertex[][] | undefined;
        if (kind === "merge") {
          const resolvedMergeRings = props["resolvedMergeRings"] as { op: BooleanOp; ring: Ring }[] | undefined;
          pathEl.setAttribute("d", resolvedMergeRings ? multiPolygonToPathD(composeRings(resolvedMergeRings)) : "");
          pathEl.setAttribute("fill-rule", "evenodd");
        } else if (rings && rings.length > 0) {
          // §5.5e: merge の Bake（Illustrator Expand 相当）で生まれた複数リング（穴・分離図形）。
          // vertices より優先。
          pathEl.setAttribute("d", buildMultiRingPathD(rings));
          pathEl.setAttribute("fill-rule", "evenodd");
        } else {
          const vertices = props["vertices"] as ResolvedShapeVertex[] | undefined;
          pathEl.setAttribute("d", vertices ? buildShapePathD(vertices) : "");
          pathEl.removeAttribute("fill-rule");
        }
        pathEl.setAttribute("fill", fill ? rgbaCss(fill) : "#888");
        break;
      }
      // path/merge から戻された場合、残置 svg を掃除する。
      const staleSvg = el.querySelector("svg[data-mafter-shape-path]");
      if (staleSvg) el.removeChild(staleSvg);
      const size = props["size"] as { x: number; y: number } | undefined;
      const radiusTL = (props["radiusTL"] as number | undefined) ?? 0;
      const radiusTR = (props["radiusTR"] as number | undefined) ?? 0;
      const radiusBR = (props["radiusBR"] as number | undefined) ?? 0;
      const radiusBL = (props["radiusBL"] as number | undefined) ?? 0;
      el.style.width = size ? `${size.x}px` : "100px";
      el.style.height = size ? `${size.y}px` : "100px";
      el.style.background = fill ? rgbaCss(fill) : "#888";
      el.style.borderRadius = kind === "ellipse" ? "50%" : `${radiusTL}px ${radiusTR}px ${radiusBR}px ${radiusBL}px`;
      break;
    }
    case "text": {
      const fontFamily = typeof props["font"] === "string" ? props["font"] : "sans-serif";
      const fontWeight = typeof props["weight"] === "number" ? props["weight"] : 400;
      const font = fontCache?.getFont(fontFamily, fontWeight) ?? null;
      // §5.5f 3D 押し出し（実 MVP 投影・非破壊トグル）。system フォント（アウトライン抽出不可）
      // またはメッシュ生成失敗、あるいは geom3dCamera 未提供のときは既存 2D 描画へフォールバック
      // する（§26.4.1 と同じ制約）。ネスト comp も §23.3b で子 comp のカメラを渡す＝3D のまま描く。
      const geom3d = parseGeom3DParams(props);
      const usedGeom3D = geom3d.enabled && geom3dCamera !== null && applyGeom3DText(el, props, font, geom3d, geom3dCamera);
      if (usedGeom3D) {
        // 親 div（entry.div）に applyObject が焼いた CSS 3D 傾け（matrix3d）を打ち消す。
        // GL 側の mvp が実投影を担うため、el/canvas はスクリーン空間 2D 配置のままでよい。
        if (el.parentElement) el.parentElement.style.transform = "";
      } else {
        clearGeom3DCanvas(el);
        applyTextEl(el, props, textQuality, font);
      }
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
      // §11.4b 画質ティアに応じた映像ファイルを選択（プロキシ無→原本フォールバック）。音声は別経路で常に原本。
      const quality = normalizeFootageQuality(props["footageQuality"]);
      // §16.2b packed alpha は decode-bound 回避のため preview/bundle live で既定 proxy tier に
      // 差し替える。決定論 export（exportStep）は packed 専用の Export Quality プロパティ
      // （既定 original）を使う — preview quality（quality/footageQuality）とは独立に選べる。
      // preview quality が PACKED_SAME_AS_EXPORT（Same as Export Quality）のときは Export Quality
      // にそのまま追従する。URL とレイアウト（下の packedLayout）は必ず同じ effQuality で対にして引く。
      const isPackedAsset = assetId ? imageCache?.getPackedAlphaLayout(assetId) != null : false;
      const effQuality = isPackedAsset
        ? effectivePackedQuality(normalizePackedPreviewSelection(props["footageQuality"]), {
            exportStep: exportVideoStep,
            exportQuality: normalizeFootageQuality(props["packedExportQuality"]),
          })
        : quality;
      const src = assetId ? (imageCache?.getUrlForQuality(assetId, effQuality) ?? "") : "";
      if (video.getAttribute("src") !== src) {
        video.src = src;
        // §11.4 mute は syncVideoElementTime がモード別に制御（再生中のみアンミュート）。
        // 初期状態は scrub 経路で muted=true になる。
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        video.controls = false;
      }
      attachPresentedClock(video);
      const trimStart = (props["trimStart"] as number | undefined) ?? 0;
      const t = Math.max(0, (hostFrame - hostInPoint) / fps + trimStart / fps);
      // §11.4 内蔵音声の音量（resolve 済み scalar）。再生中のみ実際に鳴る（muted 制御は syncVideoElementTime）。
      const gain = typeof props["gain"] === "number" ? (props["gain"] as number) : 1;
      video.volume = Math.max(0, Math.min(1, gain));
      // §11.4 カット境界の resync 要否は「ct と target の差」ではなく target の軌道の連続性で
      // 判定する（decode lag を理由に seek すると、真に連続するシームレス境界の映像・音声の
      // 連続をカットごとに壊す）。trim-in がずれた再取得のみ半フレーム精度で seek。
      const prevTargetSec = Number(video.dataset.mafterTargetSec);
      const prevTargetFrame = Number(video.dataset.mafterTargetFrame);
      const cutSeek =
        forceSeek &&
        !isSourceContinuousAcrossCut(
          Number.isFinite(prevTargetSec) ? prevTargetSec : undefined,
          Number.isFinite(prevTargetFrame) ? prevTargetFrame : undefined,
          t,
          hostFrame,
          fps,
        );
      syncVideoElementTime(video, t, fps, {
        playbackMode: previewVideoPlayback,
        exportStep: exportVideoStep,
        forceSeek: cutSeek,
        pauseForSync: previewVideoPlayback && pauseForSync,
        forceMuted: muteVideoPlayback || persistentlyMuted,
        playbackRateForSync,
      });
      if (exportVideoStep) {
        video.setAttribute(EXPORT_VIDEO_TARGET_ATTR, String(t));
      } else {
        video.removeAttribute(EXPORT_VIDEO_TARGET_ATTR);
      }
      // §11.4 preview/bundle warm-up 用に現フレームの target 時刻と assetId を記録（export attr とは別）。
      // mafterTargetFrame はカット境界の連続性判定（isSourceContinuousAcrossCut）が読む。
      video.dataset.mafterTargetSec = String(t);
      video.dataset.mafterTargetFrame = String(hostFrame);
      if (assetId) video.dataset.mafterVideoAsset = assetId;
      else delete video.dataset.mafterVideoAsset;
      const size = assetId ? imageCache?.getSize(assetId) : null;
      if (size) {
        video.style.width = `${size.width}px`;
        video.style.height = `${size.height}px`;
      }
      const alphaUrl = assetId ? imageCache?.getAlphaVideoUrl(assetId) : null;
      const packedLayout = !alphaUrl && assetId
        ? imageCache?.getPackedAlphaLayoutForQuality(assetId, effQuality) ?? null
        : null;
      if (alphaUrl) {
        if (video.parentElement) clearAlphaRemnants(video.parentElement, "split");
        const companion = ensureSplitAlphaCompanion(video);
        if (companion.alphaVideo.getAttribute("src") !== alphaUrl) {
          companion.alphaVideo.src = alphaUrl;
          companion.alphaVideo.muted = true;
          companion.alphaVideo.playsInline = true;
          companion.alphaVideo.preload = "auto";
          companion.alphaVideo.controls = false;
        }
        mirrorSplitAlphaVideoState(video, companion.alphaVideo);
        syncVideoElementTime(companion.alphaVideo, t, fps, {
          playbackMode: previewVideoPlayback,
          exportStep: exportVideoStep,
          forceSeek: cutSeek,
          pauseForSync: previewVideoPlayback && pauseForSync,
          forceMuted: muteVideoPlayback || persistentlyMuted,
          playbackRateForSync,
        });
        // §16.2 genlock: 定常再生中（scrub/export/カット境界/映像先行pauseのいずれでもない）
        // だけ、color の実 currentTime に合わせて alpha の playbackRate を穏やかに補正する。
        // それ以外（export の決定論 seek 等）は rate を必ず 1 に戻す（INV-2 非干渉）。
        if (previewVideoPlayback && !cutSeek && !pauseForSync && !video.paused && !companion.alphaVideo.paused) {
          applyAlphaGenlock(video, companion.alphaVideo);
        } else {
          resetAlphaGenlockRate(companion.alphaVideo);
        }
        if (exportVideoStep) {
          companion.alphaVideo.setAttribute(EXPORT_VIDEO_TARGET_ATTR, String(t));
        } else {
          companion.alphaVideo.removeAttribute(EXPORT_VIDEO_TARGET_ATTR);
        }
        setSplitAlphaPresentation(
          video,
          companion,
          true,
          size?.width ?? 100,
          size?.height ?? 100,
        );
        const drew = compositeSplitAlpha(
          video,
          companion.alphaVideo,
          companion.canvas,
          companion.maskScratch,
        );
        // §16.2 scrub 直後は seek/decode 中で読めないことがある。1 回描画に失敗した
        // ときだけ ready 後の再描画を予約する（stale canvas 固定の防止）。
        if (!drew) {
          scheduleSplitAlphaRedrawWhenReady(
            video,
            companion.alphaVideo,
            companion.canvas,
            companion.maskScratch,
          );
        }
      } else if (packedLayout) {
        // §2.2 packed alpha: <video> は 1 本だけ。companion/genlock は不発（1クロックのため不要）。
        if (video.parentElement) clearAlphaRemnants(video.parentElement, "packed");
        const companion = ensurePackedAlphaCompanion(video);
        setPackedAlphaPresentation(
          video,
          companion,
          true,
          size?.width ?? 100,
          size?.height ?? packedLayout.contentHeight,
        );
        const drew = compositePackedAlpha(video, companion.canvas, companion.maskScratch, packedLayout);
        if (!drew) {
          schedulePackedAlphaRedrawWhenReady(video, companion.canvas, companion.maskScratch, packedLayout);
        }
      } else {
        if (video.parentElement) clearAlphaRemnants(video.parentElement, "none");
        video.style.opacity = "";
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
