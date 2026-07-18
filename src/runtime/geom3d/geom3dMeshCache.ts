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

/**
 * §7（master-nested-composite-performance-plan Phase 2）Prepared Geometry Cache。
 * mesh だけでなく、描画に必要な静的 geometry 全体（bounds 込み）を持つ。cache hit すれば
 * `textToOutlineGlyphs`（outline 抽出 + nonzero 正規化 + extrude）を **一切**呼ばずに済む。
 *
 * cache key（呼び出し側が構成）は world transform / camera / color / light / opacity を**含めない**
 * ＝ それらは毎 frame uniform/matrix で更新されるため geometry は変わらない。key に含むのは
 * text / size / tracking / leading / align / box / curveQuality / depth / bevel / font identity。
 * 有界 LRU（推定 byte size 予算）。miss builder が null を返す場合（system フォント等で outline 抽出
 * 不可）は **キャッシュせず** 呼び出し側が 2D フォールバックへ倒す（誤 hit を作らない・§1.3）。
 */
export interface PreparedGeom3DText {
  mesh: MeshData;
  /** content bbox の左上（object ローカル原点へ戻す平行移動に使う）。 */
  minX: number;
  minY: number;
  width: number;
  height: number;
}

const PREPARED_MAX_BYTES = 48 * 1024 * 1024; // ~48MB。runtime-only 予算（project.json 非関与）。
const preparedCache = new Map<string, PreparedGeom3DText>();
let preparedBytes = 0;
let preparedBuildCount = 0;

function meshByteSize(m: MeshData): number {
  return m.positions.byteLength + m.normals.byteLength + m.faceGroup.byteLength + m.indices.byteLength;
}

/**
 * prepared geometry を key で取得。miss なら build() を呼ぶ。build() が null（outline 不可）なら
 * キャッシュせず null を返す（呼び出し側フォールバック）。build 呼び出し回数は
 * `geom3DPreparedBuildCount()` で観測できる（op-count ゲート・transform-only frame で 1 回）。
 */
export function getPreparedGeom3DText(
  key: string,
  build: () => PreparedGeom3DText | null,
): PreparedGeom3DText | null {
  const hit = preparedCache.get(key);
  if (hit) {
    preparedCache.delete(key);
    preparedCache.set(key, hit); // 最近使用へ移動（LRU）
    return hit;
  }
  preparedBuildCount++;
  const prepared = build();
  if (prepared === null) return null; // 誤 hit を作らない — miss のまま従来描画へ
  preparedCache.set(key, prepared);
  preparedBytes += meshByteSize(prepared.mesh);
  // byte 予算超過は LRU（最古 = Map 先頭）から eviction。最低 1 件は残す。
  while (preparedBytes > PREPARED_MAX_BYTES && preparedCache.size > 1) {
    const oldestKey = preparedCache.keys().next().value;
    if (oldestKey === undefined) break;
    const old = preparedCache.get(oldestKey);
    if (old) preparedBytes -= meshByteSize(old.mesh);
    preparedCache.delete(oldestKey);
  }
  return prepared;
}

/** テスト・プロジェクト/フォント切替時のリセット用。 */
export function clearPreparedGeom3DCache(): void {
  preparedCache.clear();
  preparedBytes = 0;
}

export function geom3DPreparedCacheSize(): number {
  return preparedCache.size;
}

/** miss builder（= outline/normalize/extrude）を実行した累積回数。op-count ゲート用。 */
export function geom3DPreparedBuildCount(): number {
  return preparedBuildCount;
}

export function resetGeom3DPreparedBuildCount(): void {
  preparedBuildCount = 0;
}
