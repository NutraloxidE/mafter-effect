import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGeom3DMeshCache, geom3DMeshCacheSize, getCachedMesh } from "../../src/runtime/geom3d/geom3dMeshCache";
import type { MeshData } from "../../src/runtime/geom3d/geom3dTypes";

function fakeMesh(): MeshData {
  return {
    positions: new Float32Array(),
    normals: new Float32Array(),
    faceGroup: new Uint8Array(),
    indices: new Uint32Array(),
    vertexCount: 0,
    triangleCount: 0,
  };
}

afterEach(() => clearGeom3DMeshCache());

describe("getCachedMesh", () => {
  it("calls build() on first request for a key, and skips it on a repeated request (cache hit)", () => {
    const build = vi.fn(fakeMesh);
    const a = getCachedMesh("k1", build);
    const b = getCachedMesh("k1", build);
    expect(build).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("calls build() again for a different key", () => {
    const build = vi.fn(fakeMesh);
    getCachedMesh("k1", build);
    getCachedMesh("k2", build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("evicts the least-recently-used entry once the cache exceeds its max size", () => {
    const build = vi.fn(fakeMesh);
    for (let i = 0; i < 65; i++) getCachedMesh(`key-${i}`, build);
    expect(geom3DMeshCacheSize()).toBeLessThanOrEqual(64);
    // key-0 should have been evicted (oldest, never re-touched)
    const callsBefore = build.mock.calls.length;
    getCachedMesh("key-0", build);
    expect(build.mock.calls.length).toBe(callsBefore + 1); // miss = rebuilt
  });

  it("clearGeom3DMeshCache empties the cache", () => {
    getCachedMesh("k1", fakeMesh);
    expect(geom3DMeshCacheSize()).toBeGreaterThan(0);
    clearGeom3DMeshCache();
    expect(geom3DMeshCacheSize()).toBe(0);
  });
});
