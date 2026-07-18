import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPreparedGeom3DCache,
  geom3DPreparedBuildCount,
  geom3DPreparedCacheSize,
  getPreparedGeom3DText,
  resetGeom3DPreparedBuildCount,
  type PreparedGeom3DText,
} from "../../src/runtime/geom3d/geom3dMeshCache";
import type { MeshData } from "../../src/runtime/geom3d/geom3dTypes";

/**
 * Phase 2 回帰ゲート（master-nested-composite-performance-plan §7.3）。
 * prepared geometry cache は transform-only frame で outline/normalize/extrude を 1 回だけ実行し、
 * geometry を変える key（text/font/size/depth/bevel…）でのみ miss する。null builder は誤 hit を作らない。
 */

function mesh(bytes: number): MeshData {
  const n = Math.max(1, Math.floor(bytes / 4));
  return {
    positions: new Float32Array(n),
    normals: new Float32Array(n),
    faceGroup: new Uint8Array(n),
    indices: new Uint32Array(n),
    vertexCount: n,
    triangleCount: n / 3,
  };
}

function prepared(bytes = 64): PreparedGeom3DText {
  return { mesh: mesh(bytes), minX: 1, minY: 2, width: 10, height: 20 };
}

afterEach(() => {
  clearPreparedGeom3DCache();
  resetGeom3DPreparedBuildCount();
});

describe("getPreparedGeom3DText", () => {
  it("builds once for a key, then hits (transform-only frames build outline = 1)", () => {
    const build = vi.fn(() => prepared());
    // 100 transform-only frames = 同一 geometry key を 100 回要求。
    for (let f = 0; f < 100; f++) getPreparedGeom3DText("k", build);
    expect(build).toHaveBeenCalledTimes(1);
    expect(geom3DPreparedBuildCount()).toBe(1);
    expect(geom3DPreparedCacheSize()).toBe(1);
  });

  it("returns the same cached object (mesh/bounds identity) on hit", () => {
    const p = prepared();
    const build = vi.fn(() => p);
    const a = getPreparedGeom3DText("k", build)!;
    const b = getPreparedGeom3DText("k", build)!;
    expect(a).toBe(b);
    expect(a.mesh).toBe(p.mesh);
    expect(a.minX).toBe(1);
    expect(a.minY).toBe(2);
  });

  it("misses for a different geometry key (text/size/depth change)", () => {
    const build = vi.fn(() => prepared());
    getPreparedGeom3DText("text=A|size=48|depth=10", build);
    getPreparedGeom3DText("text=B|size=48|depth=10", build); // 文字違い
    getPreparedGeom3DText("text=A|size=72|depth=10", build); // size 違い
    getPreparedGeom3DText("text=A|size=48|depth=20", build); // depth 違い
    expect(build).toHaveBeenCalledTimes(4);
  });

  it("does NOT cache when builder returns null (system font / outline unavailable)", () => {
    const build = vi.fn(() => null);
    expect(getPreparedGeom3DText("sys", build)).toBeNull();
    expect(getPreparedGeom3DText("sys", build)).toBeNull();
    // 誤 hit を作らない — 毎回 miss して従来経路（false 復帰）へ倒す。
    expect(build).toHaveBeenCalledTimes(2);
    expect(geom3DPreparedCacheSize()).toBe(0);
  });

  it("evicts LRU entries once the byte budget is exceeded, and rebuilds on re-request", () => {
    // 各 entry ~8MB。48MB 予算 → 6 件強で eviction が始まる。
    const bytesPer = 8 * 1024 * 1024;
    const build = vi.fn(() => prepared(bytesPer));
    for (let i = 0; i < 12; i++) getPreparedGeom3DText(`k${i}`, build);
    // 予算内に収まっている（無制限に増えない）。
    expect(geom3DPreparedCacheSize()).toBeLessThan(12);
    expect(geom3DPreparedCacheSize()).toBeGreaterThanOrEqual(1);
    // 最古 k0 は eviction 済み → 再要求で rebuild（miss）。
    const before = build.mock.calls.length;
    getPreparedGeom3DText("k0", build);
    expect(build.mock.calls.length).toBe(before + 1);
  });

  it("keeps a re-touched entry warm across eviction (LRU move-to-recent)", () => {
    const bytesPer = 8 * 1024 * 1024;
    const build = vi.fn(() => prepared(bytesPer));
    getPreparedGeom3DText("hot", build); // 1 回だけ build
    for (let i = 0; i < 12; i++) {
      getPreparedGeom3DText(`fill${i}`, build);
      getPreparedGeom3DText("hot", build); // 毎回 touch して LRU 最前へ
    }
    // hot は build が 1 回きり（eviction されていない）。
    const hotBuilds = build.mock.calls.length;
    getPreparedGeom3DText("hot", build);
    expect(build.mock.calls.length).toBe(hotBuilds); // hit のまま
  });

  it("clear empties cache and resets byte accounting", () => {
    getPreparedGeom3DText("k", () => prepared());
    expect(geom3DPreparedCacheSize()).toBe(1);
    clearPreparedGeom3DCache();
    expect(geom3DPreparedCacheSize()).toBe(0);
    // clear 後も予算会計が壊れていない（再挿入して LRU が正常動作）。
    const build = vi.fn(() => prepared());
    getPreparedGeom3DText("k2", build);
    expect(geom3DPreparedCacheSize()).toBe(1);
  });
});
