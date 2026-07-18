// GPU Raster Pipeline — Phase 4: engine-private な GPU effect レジストリ。
//
// builtin effect の CPU `processPixels`（reference・不変）に対し、任意で GPU 実装を持てる型を宣言する。
// Plugin API v1（`EffectDef` / `executionPath`）は非破壊・非直列化。どの effect が GPU 可能かは
// ここの集合だけで判定し、`c.type` 以外の分岐を増やさない。CPU reference は全 effect 分残す（§9）。
//
// 実際の shader は WebGl2Compositor 側に閉じる（GL 内部型を晒さない）。ここは「どの type が GPU 可能か」
// の唯一の真とする。未対応 effect が chain に1つでもあれば adjustment frame は丸ごと CPU（§7 案A）。

/** GPU pass を持つ builtin effect type（reference CPU 実装は別途 builtinEffects.ts に常存）。 */
const GPU_EFFECT_TYPES: ReadonlySet<string> = new Set<string>([
  "mosaic",
]);

/** この effect type に GPU 実装（GpuEffectPass 相当）があるか。 */
export function isGpuEffectSupported(type: string): boolean {
  return GPU_EFFECT_TYPES.has(type);
}
