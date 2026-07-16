// §19.5 / §27.4.1 — comp の live/raster 経路を純関数で算出（DOM/乱数なし・INV-1/7 整合）。

import type { Project, SceneObject, TimelineComposition } from "../core/schema";
import { hasEnabledFullDisplacement, needsSvgDisplaceCapture } from "../runtime/effectRouting";
import { isPackedAlphaVideoMeta, isSplitAlphaVideoMeta } from "../runtime/imageAssetCache";
import { globalPluginRegistry } from "../runtime/pluginRegistry";
import { resolveGeom3DCanvasHosts, toGeom3DLayerInfo } from "../runtime/geom3d/geom3dCanvasGroup";

export type PipelineSegmentKind = "live" | "raster";

export interface PipelineSegment {
  objectId: string;
  objectName: string;
  zOrder: number;
  kind: PipelineSegmentKind;
  /** raster 出力が確定境界になるか（§27.4.1 軸2） */
  isDefiniteBoundary: boolean;
  reason: string;
  isAdjustment?: boolean;
  adjustmentMode?: "live" | "raster";
  depth: number;
  /** precomp 内のネスト解析（depth+1） */
  nested?: PipelineAnalysisResult;
}

export interface PipelineCliff {
  /** segments 内の cliff 中央インデックス */
  atIndex: number;
  message: string;
}

/** §19.5 — split alpha 透過レイヤーの毎フレーム二重描画警告（live/raster 段数とは独立の軸）。 */
export interface PipelineAlphaWarning {
  objectId: string;
  objectName: string;
  depth: number;
  message: string;
}

/** §5.5f — WebGL context を消費する **canvas 数**の静的な目安（precomp を再帰集約）。 */
export interface PipelineGlLayers {
  /** 3D-extrude text の canvas 数（§5.5f-1 geomShareCanvas のグループは 1 canvas） */
  geom3d: number;
  /** split / packed alpha video（GL 合成器・予算 8 でそれ以上は CPU フォールバック） */
  alphaVideo: number;
  /** 合計（≒ 同時に必要な context 数の目安） */
  total: number;
}

export interface PipelineAnalysisResult {
  segments: PipelineSegment[];
  rasterPassCount: number;
  /** mp4/png export 時に Live調整が auto_raster される追加段数 */
  exportRasterExtra: number;
  summaryLabel: string;
  summaryTone: "light" | "moderate" | "heavy" | "severe";
  cliffs: PipelineCliff[];
  /** §19.5 split alpha 透過レイヤー警告（precomp nested を再帰集約・cliffs とは異なり伝播する）。 */
  alphaWarnings: PipelineAlphaWarning[];
  /** §5.5f WebGL context 上限（~16）に対する消費レイヤー数の目安（precomp 再帰集約）。 */
  glLayers: PipelineGlLayers;
}

const MAX_PRECOMP_DEPTH = 4;

/**
 * Chrome の同時 WebGL context 上限（1 ドキュメント・実測 ~16）。超えると
 * `Too many active WebGL contexts. Oldest context will be lost.` で古い context が黙って破棄される。
 */
export const WEBGL_CONTEXT_LIMIT = 16;

/** 上限に近づいた警告を出す閾値（余裕を持って手前で知らせる）。 */
export const WEBGL_CONTEXT_WARN_AT = 12;

function compIdFromObject(obj: SceneObject): string | null {
  for (const c of obj.components) {
    if (c.type !== "comp") continue;
    const id = c.props["compId"];
    if (typeof id === "object" && id !== null && "value" in id) {
      const v = (id as { value: unknown }).value;
      if (typeof v === "string") return v;
    }
    if (typeof id === "string") return id;
  }
  return null;
}

const SPLIT_ALPHA_MESSAGE =
  "透過チャンネル（split alpha）— 毎フレーム CPU で2回描画（color+mask 合成）されるため、live 同期のドリフト要因になります";

/** §19.5 — video component が参照する split alpha asset を検出する。 */
function hasSplitAlphaVideo(obj: SceneObject, project: Project): boolean {
  for (const c of obj.components) {
    if (c.type !== "video") continue;
    const assetId = typeof c.props["asset"] === "string" ? c.props["asset"] : null;
    if (!assetId) continue;
    const asset = project.assets.find((a) => a.id === assetId);
    if (asset?.kind === "video" && isSplitAlphaVideoMeta(asset.meta)) return true;
  }
  return false;
}

/**
 * §19.5 — split alpha 透過レイヤー警告を precomp nested まで再帰収集する。
 * segments/cliffs の live/raster 判定（effects 依存）とは独立の走査のため、
 * effect を持たない video レイヤーや precomp レイヤーも漏れなく対象にする。
 */
function collectAlphaWarnings(
  comp: TimelineComposition,
  project: Project,
  depth: number,
): PipelineAlphaWarning[] {
  const warnings: PipelineAlphaWarning[] = [];
  for (const obj of comp.objects) {
    if (hasSplitAlphaVideo(obj, project)) {
      warnings.push({ objectId: obj.id, objectName: obj.name, depth, message: SPLIT_ALPHA_MESSAGE });
    }
    if (depth >= MAX_PRECOMP_DEPTH) continue;
    const nestedCompId = compIdFromObject(obj);
    if (!nestedCompId) continue;
    const nestedComp = project.compositions.find(
      (c) => c.id === nestedCompId && c.kind === "timeline",
    );
    if (nestedComp && nestedComp.kind === "timeline") {
      warnings.push(...collectAlphaWarnings(nestedComp, project, depth + 1));
    }
  }
  return warnings;
}

/**
 * §5.5f 既知のリスク — WebGL context を消費する **canvas** を precomp まで再帰カウントする。
 *
 * Chrome の同時 WebGL context は **1 ドキュメント ~16** が上限で、超えると古い context から
 * 黙って破棄される（＝先に描いたレイヤーの絵が消える）。`geom3d` は canvas ごとに 1 context で、
 * §5.5f-1 の geomShareCanvas で合流したグループは**まとめて 1 canvas**＝1 context。
 *
 * **これは静的な目安**（実際の context 数ではない）。frame 依存の in/out 点や、
 * alpha video の予算超過時の CPU フォールバックまでは見ない。上限に近づいたことを
 * ユーザーへ早めに知らせる応急的な指標として使う。
 */
function collectGlLayers(
  comp: TimelineComposition,
  project: Project,
  depth: number,
): { geom3d: number; alphaVideo: number } {
  let alphaVideo = 0;
  const enabled = comp.objects.filter((o) => o.enabled !== false);
  // 共有チェーンは DomRenderer と同じ host 解決を通す＝distinct host 数がそのまま canvas 数。
  const hosts = resolveGeom3DCanvasHosts(enabled.map(toGeom3DLayerInfo));
  let geom3d = new Set(hosts.values()).size;
  for (const obj of enabled) {
    if (hasAlphaGlVideo(obj, project)) alphaVideo += 1;

    if (depth >= MAX_PRECOMP_DEPTH) continue;
    const nestedCompId = compIdFromObject(obj);
    if (!nestedCompId) continue;
    const nestedComp = project.compositions.find(
      (c) => c.id === nestedCompId && c.kind === "timeline",
    );
    if (nestedComp && nestedComp.kind === "timeline") {
      // 同じ precomp を 2 回置けば context も 2 倍要る＝重複カウントが正しい。
      const n = collectGlLayers(nestedComp, project, depth + 1);
      geom3d += n.geom3d;
      alphaVideo += n.alphaVideo;
    }
  }
  return { geom3d, alphaVideo };
}

/** §2.1/§2.2 — GL 合成器（split / packed alpha）を要する video を検出する。 */
function hasAlphaGlVideo(obj: SceneObject, project: Project): boolean {
  for (const c of obj.components) {
    if (c.type !== "video") continue;
    const assetId = typeof c.props["asset"] === "string" ? c.props["asset"] : null;
    if (!assetId) continue;
    const asset = project.assets.find((a) => a.id === assetId);
    if (asset?.kind !== "video") continue;
    if (isSplitAlphaVideoMeta(asset.meta) || isPackedAlphaVideoMeta(asset.meta)) return true;
  }
  return false;
}

function enabledEffects(obj: SceneObject) {
  return (obj.effects ?? []).filter((e) => e.enabled);
}

/** raster を強制する displacement = **full** のみ（Fast* は live・§27.12 改定3）。 */
function hasDisplacement(effects: { type: string; enabled: boolean }[]): boolean {
  return hasEnabledFullDisplacement(effects);
}

function hasRasterExecutionPath(effects: { type: string; enabled: boolean }[]): boolean {
  return effects.some((e) => {
    if (!e.enabled) return false;
    const def = globalPluginRegistry.getEffectDef(e.type);
    return def?.executionPath === "raster" || def?.processPixels !== undefined;
  });
}

function describeEffects(effects: { type: string; enabled: boolean }[]): string {
  const labels = effects
    .filter((e) => e.enabled)
    .map((e) => globalPluginRegistry.getEffectDef(e.type)?.label ?? e.type);
  return labels.length > 0 ? labels.join(", ") : "effect";
}

/** 単一レイヤーの preview 経路（DomRenderer と整合） */
export function layerPipelineKind(obj: SceneObject): PipelineSegmentKind | null {
  if (obj.isNull || !obj.enabled) return null;
  const fx = enabledEffects(obj);
  if (fx.length === 0) return null;

  if (obj.isAdjustment) {
    const mode = obj.adjustmentMode ?? "live";
    if (mode === "raster") return "raster";
    if (hasDisplacement(fx)) return "raster";
    return "live";
  }

  if (hasRasterExecutionPath(fx)) return "raster";
  if (needsSvgDisplaceCapture({
    isAdjustment: false,
    effects: obj.effects,
    hasLiveFilterTokens: false,
  })) return "raster";
  return "live";
}

function layerReason(obj: SceneObject, kind: PipelineSegmentKind): string {
  const fx = enabledEffects(obj);
  const label = describeEffects(fx);
  if (obj.isAdjustment) {
    const mode = obj.adjustmentMode ?? "live";
    if (mode === "raster") return `Raster調整 · ${label}`;
    if (kind === "raster") return `Live調整 · ${label}（背面 capture）`;
    return `Live調整 · ${label}`;
  }
  if (kind === "raster" && hasDisplacement(fx)) {
    return `${label}（自己 capture・ドリフト回避）`;
  }
  return label;
}

function detectCliffs(segments: PipelineSegment[]): PipelineCliff[] {
  const cliffs: PipelineCliff[] = [];
  for (let i = 0; i < segments.length - 2; i++) {
    const a = segments[i];
    const b = segments[i + 1];
    const c = segments[i + 2];
    if (!a || !b || !c) continue;
    if (a.kind === "live" && b.kind === "raster" && c.kind === "live") {
      cliffs.push({
        atIndex: i + 1,
        message: `${a.objectName} → ${b.objectName} → ${c.objectName}: live↔raster 交替（崖）。Raster をまとめるか Live 調整を統合すると軽量化できます`,
      });
    }
  }
  return cliffs;
}

function buildSummary(rasterPassCount: number): Pick<PipelineAnalysisResult, "summaryLabel" | "summaryTone"> {
  if (rasterPassCount === 0) return { summaryLabel: "軽量（raster 0段）", summaryTone: "light" };
  if (rasterPassCount === 1) return { summaryLabel: "raster 1段", summaryTone: "moderate" };
  if (rasterPassCount === 2) return { summaryLabel: "raster 2段・やや重い", summaryTone: "heavy" };
  return { summaryLabel: `raster ${rasterPassCount}段+・重い`, summaryTone: "severe" };
}

function analyzeComp(
  comp: TimelineComposition,
  project: Project,
  depth: number,
): PipelineAnalysisResult {
  const segments: PipelineSegment[] = [];
  let exportRasterExtra = 0;

  const sorted = [...comp.objects].sort((a, b) => a.zOrder - b.zOrder);
  for (const obj of sorted) {
    const kind = layerPipelineKind(obj);
    if (!kind) continue;

    const fx = enabledEffects(obj);
    if (
      obj.isAdjustment &&
      (obj.adjustmentMode ?? "live") === "live" &&
      fx.length > 0 &&
      !hasDisplacement(fx)
    ) {
      exportRasterExtra += 1;
    }

    const nestedCompId = compIdFromObject(obj);
    let nested: PipelineAnalysisResult | undefined;
    if (nestedCompId && depth < MAX_PRECOMP_DEPTH) {
      const nestedComp = project.compositions.find(
        (c) => c.id === nestedCompId && c.kind === "timeline",
      );
      if (nestedComp && nestedComp.kind === "timeline") {
        nested = analyzeComp(nestedComp, project, depth + 1);
      }
    }

    segments.push({
      objectId: obj.id,
      objectName: obj.name,
      zOrder: obj.zOrder,
      kind,
      isDefiniteBoundary: kind === "raster",
      reason: layerReason(obj, kind),
      isAdjustment: obj.isAdjustment,
      adjustmentMode: obj.isAdjustment ? (obj.adjustmentMode ?? "live") : undefined,
      depth,
      nested,
    });
  }

  const rasterPassCount = segments.filter((s) => s.kind === "raster").length
    + segments.reduce((n, s) => n + (s.nested?.rasterPassCount ?? 0), 0);

  const { summaryLabel, summaryTone } = buildSummary(rasterPassCount);

  return {
    segments,
    rasterPassCount,
    exportRasterExtra,
    summaryLabel,
    summaryTone,
    cliffs: detectCliffs(segments),
    // alphaWarnings / glLayers は専用の再帰集約関数が独立に走査するため、
    // ここ（nested 中間結果を含む）では空値を置き、公開 entry point で埋める。
    alphaWarnings: [],
    glLayers: { geom3d: 0, alphaVideo: 0, total: 0 },
  };
}

/** §19.5 — アクティブ comp のパイプライン解析（precomp 再帰 depth ≤ 4） */
export function pipelineAnalysis(
  comp: TimelineComposition,
  project: Project,
): PipelineAnalysisResult {
  const gl = collectGlLayers(comp, project, 0);
  return {
    ...analyzeComp(comp, project, 0),
    alphaWarnings: collectAlphaWarnings(comp, project, 0),
    glLayers: { ...gl, total: gl.geom3d + gl.alphaVideo },
  };
}
