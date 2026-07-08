// §11.4b — video footage の画質ティア定義（純関数・UI/ランタイム共有）。
// 「どの映像ファイルを使うか」のティアと、Inspector の UI グルーピング・friendly ラベルを
// 1 箇所に集約する。プロキシの生成・解決自体は footagePlayback.ts / cache 側で行う。

/** footage 画質ティア。`original` は原本、それ以外は生成プロキシ（軽量編集用）。 */
export type FootageQuality =
  | "original"
  | "high"
  | "medium"
  | "low"
  | "super_low"
  | "potato"
  | "garbage";

export const FOOTAGE_QUALITY_TIERS: readonly FootageQuality[] = [
  "original",
  "high",
  "medium",
  "low",
  "super_low",
  "potato",
  "garbage",
] as const;

/** 既定ティア。未設定の project.json / 新規 video レイヤーはこれにフォールバック（後方互換）。 */
export const DEFAULT_FOOTAGE_QUALITY: FootageQuality = "original";

/** プロキシ tier の生成パラメータ（長辺 px とエンコード品質ヒント）。`original` は対象外。 */
export interface ProxyTierParams {
  /** プロキシ映像の長辺ピクセル上限。 */
  maxDim: number;
  /** WebCodecs/canvas 再エンコードの品質ヒント（0..1）。 */
  quality: number;
}

export type ProxyTier = Exclude<FootageQuality, "original">;

export const PROXY_TIER_PARAMS: Record<ProxyTier, ProxyTierParams> = {
  high: { maxDim: 1440, quality: 0.85 },
  medium: { maxDim: 960, quality: 0.7 },
  low: { maxDim: 640, quality: 0.55 },
  super_low: { maxDim: 426, quality: 0.45 },
  potato: { maxDim: 256, quality: 0.35 },
  garbage: { maxDim: 128, quality: 0.25 },
} as const;

export function isProxyTier(q: FootageQuality): q is ProxyTier {
  return q !== "original";
}

/** Inspector の optgroup（§11.4b・英語ラベル v1）。 */
export interface QualityUiGroup {
  label: string;
  tiers: readonly FootageQuality[];
}

export const QUALITY_UI_GROUPS: readonly QualityUiGroup[] = [
  { label: "Source", tiers: ["original"] },
  { label: "Editing", tiers: ["high", "medium", "low"] },
  { label: "Performance", tiers: ["super_low", "potato", "garbage"] },
] as const;

const FRIENDLY_LABELS: Record<FootageQuality, string> = {
  original: "Original",
  high: "High",
  medium: "Medium",
  low: "Low",
  super_low: "Super Low",
  potato: "Potato",
  garbage: "Garbage (preview)",
};

/** UI 表示用の人間可読ラベル。 */
export function footageQualityLabel(q: FootageQuality): string {
  return FRIENDLY_LABELS[q];
}

/** 任意の raw 値（props から読んだ unknown）を既知ティアへ正規化。不明値は既定へ。 */
export function normalizeFootageQuality(raw: unknown): FootageQuality {
  if (typeof raw === "string" && (FOOTAGE_QUALITY_TIERS as readonly string[]).includes(raw)) {
    return raw as FootageQuality;
  }
  return DEFAULT_FOOTAGE_QUALITY;
}

/**
 * §16.2b — packed alpha 専用の既定 proxy tier。原本 packed は content の2倍近い縦解像度
 * （color+mask 上下パック）を持ち、webm(VP9 ソフトウェアデコード)に落ちた場合に実時間再生
 * できず holdTimeline が慢性発火する（実機計測: 8秒の壁時計でタイムライン進行が約半分）。
 * VP9 ソフトデコードでも確実に実時間へ収まるよう、通常 footage の既定（medium）より
 * 保守的に低い tier を既定にする。
 *
 * **この既定は「未設定（プロパティが無い）」場合にのみ適用する。ユーザーが明示的に
 * "Original" を選んだ場合は文字通り原本を使う**（2026-07 変更・以前は "Original" 選択時も
 * 黙って本 tier に差し替えていたが、ユーザーから見て不透明だったため撤回した。既定値そのものを
 * この tier にする＝新規レイヤー作成時に prop へ明示的に書き込むことで、decode-bound 回避は
 * 「ドロップダウンの初期選択」として可視化する。詳細は `applySubjectExtractToProject` 参照）。
 */
const PACKED_DEFAULT_PROXY_TIER: ProxyTier = "low";

export interface PackedQualityMode {
  /** true = 決定論 export（mp4/webm/PNG、および bundle bake の compFrameCapture）ステップ中。 */
  exportStep?: boolean;
  /**
   * `exportStep` 時に使う quality（packed レイヤー専用「Export Quality」プロパティ由来）。
   * 未指定 / `"original"` なら原本のまま（既定・INV-2 非干渉 — デコード速度に依存させない）。
   * 決定論性そのものは崩さない: どの tier でもフレームごとの決定論 seek で選ぶため INV-2 は保たれる。
   * preview 側で `previewSelection` が `PACKED_SAME_AS_EXPORT` のときもこの値がそのまま使われる。
   */
  exportQuality?: FootageQuality;
}

/** packed レイヤー専用「Preview Quality」の特殊選択肢: Export Quality の値にそのまま追従する。 */
export const PACKED_SAME_AS_EXPORT = "same_as_export" as const;

/** packed レイヤーの Preview Quality プロパティが取りうる値（通常 tier + リンク特殊値）。 */
export type PackedPreviewSelection = FootageQuality | typeof PACKED_SAME_AS_EXPORT;

export function isPackedSameAsExport(v: unknown): v is typeof PACKED_SAME_AS_EXPORT {
  return v === PACKED_SAME_AS_EXPORT;
}

/**
 * 任意の raw 値（packed レイヤーの footageQuality prop）を PackedPreviewSelection へ正規化。
 * **未設定（`undefined`）・不明値のときだけ** 既定 proxy tier（`low`）にフォールバックする。
 * `"original"` を含む既知の値は常にそのまま尊重する（2026-07 変更・§16.2b 参照）。
 */
export function normalizePackedPreviewSelection(raw: unknown): PackedPreviewSelection {
  if (isPackedSameAsExport(raw)) return PACKED_SAME_AS_EXPORT;
  if (typeof raw === "string" && (FOOTAGE_QUALITY_TIERS as readonly string[]).includes(raw)) {
    return raw as FootageQuality;
  }
  return PACKED_DEFAULT_PROXY_TIER;
}

/**
 * packed alpha レイヤーに実際に使う quality を決める純関数。
 * - 決定論 export（`exportStep`）は `mode.exportQuality`（packed 専用 Export Quality プロパティ、
 *   既定 `"original"`）をそのまま使う。preview quality（`previewSelection`）とは独立。
 * - preview / bundle live（exportStep 無し）:
 *   - `previewSelection === PACKED_SAME_AS_EXPORT` なら `mode.exportQuality` にそのまま追従する
 *     （Export Quality が `"original"` ならプレビューも文字通り原本を使う）。
 *   - それ以外は `previewSelection` を**常にそのまま**使う。`"original"` が明示的に選ばれて
 *     いれば文字通り原本を使う（decode-bound になり得ることを承知の上でのユーザーの明示選択、
 *     2026-07 変更）。未設定時の安全側フォールバック（`low`）は `normalizePackedPreviewSelection`
 *     側（呼び出し前）と新規レイヤー作成時の初期値書き込みで担保する。
 * packed 以外の通常 video はこの関数を通さない（呼び出し側で isPackedAlphaVideoMeta 等で分岐）。
 */
export function effectivePackedQuality(
  previewSelection: PackedPreviewSelection,
  mode: PackedQualityMode,
): FootageQuality {
  if (mode.exportStep) return mode.exportQuality ?? "original";
  if (previewSelection === PACKED_SAME_AS_EXPORT) return mode.exportQuality ?? "original";
  return previewSelection;
}
