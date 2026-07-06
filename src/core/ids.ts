import { ulid } from "ulid";
import type { AssetId, CompId, ObjectId } from "./schema";

// ULID 生成は ID 採番時のみ。resolve()（純関数）からは絶対に呼ばない (INV-1)。
// 参照はすべて stable ID。name は参照に使わない (INV-6)。

export function newObjectId(): ObjectId {
  return ulid();
}

export function newCompId(): CompId {
  return ulid();
}

export function newAssetId(): AssetId {
  return ulid();
}

export function newBinId(): string {
  return ulid();
}

export function newVertexId(): string {
  return ulid();
}
