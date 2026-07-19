// master-nested-composite-performance-plan Phase 2/3 — 非破壊 runtime-only キャッシュ flag。
//
// いずれも既定 OFF（挙動不変）。project.json に保存しない・INV 非関与・dev/bench 用。
// flag ON でも「miss は必ず従来経路へ倒す」設計（§1.3 cache 契約）。
//
//   globalThis.__mafterPreparedGeomCache = true   // Phase 2: 3D text prepared geometry cache
//   globalThis.__mafterGpuMeshCache = true         // Phase 3: WebGL mesh buffer 常駐 cache

/** Phase 2: 3D text の outline/normalize を transform-only frame で省く prepared geometry cache。既定 false。 */
export function isPreparedGeomCacheEnabled(): boolean {
  const g = globalThis as { __mafterPreparedGeomCache?: unknown };
  return g.__mafterPreparedGeomCache === true;
}

/** Phase 3: 共有 canvas の mesh 切替ごとの GPU buffer 再 upload を省く常駐 buffer cache。既定 false。 */
export function isGpuMeshCacheEnabled(): boolean {
  const g = globalThis as { __mafterGpuMeshCache?: unknown };
  return g.__mafterGpuMeshCache === true;
}
