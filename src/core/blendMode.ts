import type { BlendMode } from "./schema";
import { BLEND_MODES } from "./schema";

/** §5.4d: 許可された blendMode か（validate / canonicalize 用）。 */
export function isKnownBlendMode(v: string): v is BlendMode {
  return (BLEND_MODES as readonly string[]).includes(v);
}

/** §5.4d: 未知値は "normal" に収束（resolve / runtime 描画の最終フォールバック）。 */
export function normalizeBlendMode(v?: string): BlendMode {
  if (v !== undefined && v !== "" && isKnownBlendMode(v)) return v;
  return "normal";
}

/** エディタ Inspector: 未知 blendMode の表示ラベル。 */
export function formatMissingBlendModeLabel(raw: string): string {
  return `${raw} (missing)`;
}
