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
