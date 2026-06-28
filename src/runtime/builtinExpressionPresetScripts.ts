// §9 Phase 0.5 — ビルトイン expression プリセット脚本の正本（editor / FS / bundle 共有）。

import { presetExpressionScriptPath } from "../core/paths";
import type { Project, SceneObject, TimelineComposition } from "../core/schema";
import { pulseScaleScriptHelpersJs } from "./pulseScaleWave";

export type BuiltinExpressionPresetId =
  | "wiggle-position"
  | "oscillate-position"
  | "pulse-scale";

export const BUILTIN_EXPRESSION_PRESET_IDS: BuiltinExpressionPresetId[] = [
  "wiggle-position",
  "oscillate-position",
  "pulse-scale",
];

function isBuiltinPresetId(id: string): id is BuiltinExpressionPresetId {
  return (BUILTIN_EXPRESSION_PRESET_IDS as string[]).includes(id);
}

export function builtinExpressionPresetScript(id: BuiltinExpressionPresetId): string {
  switch (id) {
    case "wiggle-position":
      return `// Mafter Effect expression — wiggle position (§9)
// @mafter:preset wiggle-position
export default (ctx) => {
  const f = ctx.presetParams.frequency ?? 2;
  const a = ctx.presetParams.amplitude ?? 60;
  const s = ctx.presetParams.seed ?? 0;
  return ctx.wiggle(f, a, s);
};
`;
    case "oscillate-position":
      return `// Mafter Effect expression — oscillate position (§9)
// @mafter:preset oscillate-position
export default (ctx) => {
  const amp = ctx.presetParams.amplitude ?? 30;
  const freq = ctx.presetParams.frequency ?? 1;
  return {
    ...ctx.value,
    y: ctx.value.y + Math.sin(ctx.time * Math.PI * 2 * freq) * amp,
  };
};
`;
    case "pulse-scale":
      return `// Mafter Effect expression — pulse scale (§9)
// @mafter:preset pulse-scale
${pulseScaleScriptHelpersJs()}
export default (ctx) => {
  const amount = ctx.presetParams.amount ?? 0.1;
  const freq = ctx.presetParams.frequency ?? 2;
  const waveform = ctx.presetParams.waveform ?? "sine";
  const bend = ctx.presetParams.bend ?? 0;
  const phaseDeg = ctx.presetParams.phase ?? 0;
  const pol = ctx.presetParams.polarity === "-" ? -1 : 1;
  const raw = ctx.time * freq + phaseDeg / 360;
  const t = bendPhase(raw - Math.floor(raw), bend);
  let w;
  switch (waveform) {
    case "triangle":
      w = 1 - 4 * Math.abs(t - 0.5);
      break;
    case "square":
      w = Math.sin(t * Math.PI * 2) >= 0 ? 1 : -1;
      break;
    case "sawtooth":
      w = 2 * t - 1;
      break;
    case "sine":
    default:
      w = Math.sin(t * Math.PI * 2);
      break;
  }
  w *= pol;
  const m = 1 + amount * w;
  return { x: ctx.value.x * m, y: ctx.value.y * m, z: ctx.value.z };
};
`;
  }
}

function collectPresetIdsFromObject(obj: SceneObject, out: Set<BuiltinExpressionPresetId>): void {
  for (const inst of obj.expressionPresets ?? []) {
    if (inst.enabled && isBuiltinPresetId(inst.presetId)) {
      out.add(inst.presetId);
    }
  }

  const visitExpr = (prop: unknown): void => {
    if (!prop || typeof prop !== "object" || !("expression" in prop)) return;
    const expr = (prop as { expression?: { path?: string; enabled?: boolean } }).expression;
    if (!expr?.enabled || !expr.path) return;
    const prefix = "presets/expressions/";
    if (!expr.path.startsWith(prefix) || !expr.path.endsWith(".js")) return;
    const id = expr.path.slice(prefix.length, -3);
    if (isBuiltinPresetId(id)) out.add(id);
  };

  visitExpr(obj.opacity);
  for (const key of ["anchor", "position", "rotation", "scale"] as const) {
    visitExpr(obj.transform[key]);
  }
}

/** project 内で参照されているビルトイン expression プリセット ID を列挙。 */
export function collectUsedBuiltinPresetIds(project: Project): Set<BuiltinExpressionPresetId> {
  const out = new Set<BuiltinExpressionPresetId>();
  for (const comp of project.compositions) {
    if (comp.kind !== "timeline") continue;
    for (const obj of comp.objects) {
      collectPresetIdsFromObject(obj, out);
    }
  }
  return out;
}

/** bundle manifest.textFiles に FS 未同梱のビルトイン preset 脚本を埋め込む（FS 版があれば優先）。 */
export function injectBuiltinExpressionPresetScripts(
  project: Project,
  textFiles: Record<string, string>,
): void {
  for (const id of collectUsedBuiltinPresetIds(project)) {
    const path = presetExpressionScriptPath(id);
    if (textFiles[path]) continue;
    textFiles[path] = builtinExpressionPresetScript(id);
  }
}

/** collectBundleDependencies 用 — 参照 preset 脚本パスを textPaths に追加。 */
export function collectExpressionPresetScriptPaths(
  comp: TimelineComposition,
  out: Set<string>,
): void {
  const ids = new Set<BuiltinExpressionPresetId>();
  for (const obj of comp.objects) {
    collectPresetIdsFromObject(obj, ids);
  }
  for (const id of ids) {
    out.add(presetExpressionScriptPath(id));
  }
}
