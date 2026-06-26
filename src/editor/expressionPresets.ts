// §9 Inspector expression プリセット — 共有 FS 脚本 + project.json の props（Phase 0.5）。

import type { AnimatedProp, ParamDescriptor } from "../core/schema";
import { presetExpressionScriptPath } from "../core/paths";
import { staticProp } from "../core/props";
import type { IndexedDbFs } from "../fs/IndexedDbFs";

export type ExpressionPresetId = "wiggle-position" | "oscillate-position" | "pulse-scale";

export type ExpressionPresetParam = "position" | "scale";

export interface ExpressionPresetDef {
  readonly id: ExpressionPresetId;
  readonly param: ExpressionPresetParam;
  readonly label: string;
  readonly params: ParamDescriptor[];
  readonly script: string;
}

const PRESET_MARKER_RE = /^\/\/\s*@mafter:preset\s+(\S+)/m;

export function parsePresetMarker(source: string): ExpressionPresetId | null {
  const m = PRESET_MARKER_RE.exec(source);
  if (!m) return null;
  const id = m[1];
  if (id === "wiggle-position" || id === "oscillate-position" || id === "pulse-scale") {
    return id;
  }
  return null;
}

/** 共有 FS パス `presets/expressions/<presetId>.js` から presetId を取得。 */
export function presetIdFromExpressionPath(path: string): ExpressionPresetId | null {
  const prefix = "presets/expressions/";
  if (!path.startsWith(prefix) || !path.endsWith(".js")) return null;
  const id = path.slice(prefix.length, -3);
  if (id === "wiggle-position" || id === "oscillate-position" || id === "pulse-scale") {
    return id;
  }
  return null;
}

export const EXPRESSION_PRESETS: Record<ExpressionPresetId, ExpressionPresetDef> = {
  "wiggle-position": {
    id: "wiggle-position",
    param: "position",
    label: "Wiggle Position",
    params: [
      { key: "frequency", label: "Frequency", kind: "scalar", default: 2, animatable: true, min: 0, step: 0.1 },
      { key: "amplitude", label: "Amplitude", kind: "scalar", default: 60, animatable: true, min: 0, step: 1 },
      { key: "seed", label: "Seed", kind: "scalar", default: 0, animatable: true, step: 1 },
    ],
    script: `// Mafter Effect expression — wiggle position (§9)
// @mafter:preset wiggle-position
export default (ctx) => {
  const f = ctx.presetParams.frequency ?? 2;
  const a = ctx.presetParams.amplitude ?? 60;
  const s = ctx.presetParams.seed ?? 0;
  return ctx.wiggle(f, a, s);
};
`,
  },
  "oscillate-position": {
    id: "oscillate-position",
    param: "position",
    label: "Oscillate Position",
    params: [
      { key: "amplitude", label: "Amplitude", kind: "scalar", default: 30, animatable: true, min: 0, step: 1 },
      { key: "frequency", label: "Frequency", kind: "scalar", default: 1, animatable: true, min: 0, step: 0.1 },
    ],
    script: `// Mafter Effect expression — oscillate position (§9)
// @mafter:preset oscillate-position
export default (ctx) => {
  const amp = ctx.presetParams.amplitude ?? 30;
  const freq = ctx.presetParams.frequency ?? 1;
  return {
    ...ctx.value,
    y: ctx.value.y + Math.sin(ctx.time * Math.PI * 2 * freq) * amp,
  };
};
`,
  },
  "pulse-scale": {
    id: "pulse-scale",
    param: "scale",
    label: "Pulse Scale",
    params: [
      { key: "amount", label: "Amount", kind: "scalar", default: 0.1, animatable: true, min: 0, step: 0.01 },
      { key: "frequency", label: "Frequency", kind: "scalar", default: 2, animatable: true, min: 0, step: 0.1 },
    ],
    script: `// Mafter Effect expression — pulse scale (§9)
// @mafter:preset pulse-scale
export default (ctx) => {
  const amount = ctx.presetParams.amount ?? 0.1;
  const freq = ctx.presetParams.frequency ?? 2;
  const m = 1 + amount * Math.sin(ctx.time * Math.PI * 2 * freq);
  return { x: ctx.value.x * m, y: ctx.value.y * m, z: ctx.value.z };
};
`,
  },
};

export const EXPRESSION_PRESET_LIST: ExpressionPresetDef[] = [
  EXPRESSION_PRESETS["wiggle-position"],
  EXPRESSION_PRESETS["oscillate-position"],
  EXPRESSION_PRESETS["pulse-scale"],
];

export function presetScriptPath(presetId: ExpressionPresetId): string {
  return presetExpressionScriptPath(presetId);
}

/** プリセット定義から AnimatedProp 付き default props を構築。 */
export function buildDefaultPresetProps(presetId: ExpressionPresetId): Record<string, AnimatedProp<unknown> | unknown> {
  const def = EXPRESSION_PRESETS[presetId];
  const props: Record<string, AnimatedProp<unknown> | unknown> = {};
  for (const p of def.params) {
    props[p.key] = p.animatable ? staticProp(p.default) : p.default;
  }
  return props;
}

/** 共有脚本を FS に write-if-absent（決定論的・冪等）。 */
export async function ensurePresetScript(fs: IndexedDbFs, presetId: ExpressionPresetId): Promise<void> {
  const path = presetScriptPath(presetId);
  try {
    await fs.readText(path);
  } catch {
    await fs.write(path, EXPRESSION_PRESETS[presetId].script);
  }
}

/** 全プリセット脚本を write-if-absent。 */
export async function ensureAllPresetScripts(fs: IndexedDbFs): Promise<void> {
  await Promise.all(EXPRESSION_PRESET_LIST.map((p) => ensurePresetScript(fs, p.id)));
}
