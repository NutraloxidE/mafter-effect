import type { MeshData } from "./geom3dTypes";

/**
 * §5.2 メッシュ生成のメモ化。**P1 の設計簡略化**（geom3dTypes.ts 参照）: depth/bevelSize は
 * 実座標としてメッシュに焼き込むため、キーに含める（= depth/bevel の変更はキャッシュミス）。
 * text 内容/フォント/レイアウトが不変なら KF 再生・scrub の隣接フレームでキャッシュヒットしうる
 * （同一 depth 値へ戻ったとき等）。
 */

const MAX_ENTRIES = 64;
const cache = new Map<string, MeshData>();

export function getCachedMesh(key: string, build: () => MeshData): MeshData {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // 最近使用へ移動（簡易 LRU）
    return hit;
  }
  const mesh = build();
  cache.set(key, mesh);
  if (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  return mesh;
}

/** テスト・プロジェクト切替時のリセット用。 */
export function clearGeom3DMeshCache(): void {
  cache.clear();
}

export function geom3DMeshCacheSize(): number {
  return cache.size;
}
