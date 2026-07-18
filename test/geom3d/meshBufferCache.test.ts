import { describe, expect, it } from "vitest";
import {
  MeshBufferCache,
  type MeshBufferGl,
  type MeshBufferStats,
} from "../../src/runtime/geom3d/geom3dMeshBufferCache";
import type { MeshData } from "../../src/runtime/geom3d/geom3dTypes";

/**
 * Phase 3 回帰ゲート（master-nested-composite-performance-plan §8.3）。
 * jsdom に WebGL は無いため、最小 GL インターフェースを mock して buffer cache のロジックを検証する:
 * warm frame の bufferData=0 / drawElements 相当（indexCount）維持 / LRU eviction で deleteBuffer /
 * dispose で全解放 / geometry 変更でのみ再 upload。
 */

let nextBufId = 1;
interface MockBuffer {
  id: number;
  deleted: boolean;
}

function makeMockGl(opts: { failAfter?: number } = {}): MeshBufferGl & {
  created: MockBuffer[];
  bufferDataCalls: number;
} {
  const created: MockBuffer[] = [];
  let createdCount = 0;
  const gl = {
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    DYNAMIC_DRAW: 0x88e8,
    created,
    bufferDataCalls: 0,
    createBuffer(): WebGLBuffer | null {
      createdCount++;
      if (opts.failAfter !== undefined && createdCount > opts.failAfter) return null;
      const b: MockBuffer = { id: nextBufId++, deleted: false };
      created.push(b);
      return b as unknown as WebGLBuffer;
    },
    deleteBuffer(buffer: WebGLBuffer | null): void {
      if (buffer) (buffer as unknown as MockBuffer).deleted = true;
    },
    bindBuffer(): void {
      /* no-op */
    },
    bufferData(): void {
      gl.bufferDataCalls++;
    },
  };
  return gl;
}

function mesh(vertexBytes: number): MeshData {
  const n = Math.max(3, Math.floor(vertexBytes / 4));
  return {
    positions: new Float32Array(n),
    normals: new Float32Array(n),
    faceGroup: new Uint8Array(n),
    indices: new Uint32Array(n),
    vertexCount: n,
    triangleCount: n / 3,
  };
}

function aliveCount(gl: { created: MockBuffer[] }): number {
  return gl.created.filter((b) => !b.deleted).length;
}

describe("MeshBufferCache", () => {
  it("uploads once per mesh; warm re-draws do 0 bufferData (bind-only)", () => {
    const gl = makeMockGl();
    const cache = new MeshBufferCache(64 * 1024 * 1024);
    const stats: MeshBufferStats = { bufferUploads: 0 };
    const m = mesh(1024);
    const first = cache.getOrUpload(gl, m, stats);
    expect(first).not.toBeNull();
    expect(gl.bufferDataCalls).toBe(3); // position + normal + index
    expect(stats.bufferUploads).toBe(3);
    // 60 warm frames を模す — 同じ mesh 参照。
    for (let f = 0; f < 60; f++) {
      const again = cache.getOrUpload(gl, m, stats);
      expect(again).toBe(first); // 同一 buffer bundle
      expect(again!.indexCount).toBe(m.indices.length); // drawElements の count 維持
    }
    expect(gl.bufferDataCalls).toBe(3); // warm: 追加 upload 0
    expect(stats.bufferUploads).toBe(3);
  });

  it("uploads N distinct meshes once each; cycling A→B→C→A→B→C stays 0 after warm", () => {
    const gl = makeMockGl();
    const cache = new MeshBufferCache(64 * 1024 * 1024);
    const stats: MeshBufferStats = { bufferUploads: 0 };
    const meshes = [mesh(1024), mesh(2048), mesh(512)];
    // frame 0: 全部 miss。
    for (const m of meshes) cache.getOrUpload(gl, m, stats);
    expect(stats.bufferUploads).toBe(3 * 3);
    // frame 1..10: 同じ 3 mesh を毎 frame 描く（共有 canvas の描画順）。
    for (let f = 0; f < 10; f++) for (const m of meshes) cache.getOrUpload(gl, m, stats);
    expect(stats.bufferUploads).toBe(9); // warm: 増分ゼロ
    expect(cache.size()).toBe(3);
  });

  it("re-uploads only when the mesh identity changes (new geometry)", () => {
    const gl = makeMockGl();
    const cache = new MeshBufferCache(64 * 1024 * 1024);
    const stats: MeshBufferStats = { bufferUploads: 0 };
    const a = mesh(1024);
    cache.getOrUpload(gl, a, stats);
    cache.getOrUpload(gl, a, stats);
    expect(stats.bufferUploads).toBe(3);
    const b = mesh(1024); // 別 identity（geometry 変更）
    cache.getOrUpload(gl, b, stats);
    expect(stats.bufferUploads).toBe(6);
  });

  it("evicts LRU entries past the byte budget and deletes their buffers", () => {
    // 予算 = 2.5 entry 分。各 mesh ~ (n*4)*2 + n*4 bytes。
    const per = mesh(1 * 1024 * 1024); // positions+normals(4B) + indices(4B) ≈ 3MB
    const budget = 8 * 1024 * 1024; // ~2.6 entries
    const gl = makeMockGl();
    const cache = new MeshBufferCache(budget);
    const meshes = Array.from({ length: 8 }, () => mesh(1 * 1024 * 1024));
    for (const m of meshes) cache.getOrUpload(gl, m);
    // 予算内に収束（無制限に増えない）。
    expect(cache.byteSize()).toBeLessThanOrEqual(budget + per.positions.byteLength * 3);
    expect(cache.size()).toBeLessThan(8);
    // eviction された buffer は deleteBuffer 済み（alive = 現行 size × 3）。
    expect(aliveCount(gl)).toBe(cache.size() * 3);
  });

  it("dispose deletes all buffers and empties the cache", () => {
    const gl = makeMockGl();
    const cache = new MeshBufferCache(64 * 1024 * 1024);
    cache.getOrUpload(gl, mesh(1024));
    cache.getOrUpload(gl, mesh(1024));
    expect(aliveCount(gl)).toBe(6);
    cache.dispose(gl);
    expect(cache.size()).toBe(0);
    expect(cache.byteSize()).toBe(0);
    expect(aliveCount(gl)).toBe(0);
  });

  it("returns null and leaks no buffers when createBuffer fails", () => {
    const gl = makeMockGl({ failAfter: 1 }); // 2 個目以降 null
    const cache = new MeshBufferCache(64 * 1024 * 1024);
    const res = cache.getOrUpload(gl, mesh(1024));
    expect(res).toBeNull();
    // 部分生成した buffer は解放済み（alive 0）。
    expect(aliveCount(gl)).toBe(0);
    expect(cache.size()).toBe(0);
  });

  it("never evicts the mesh currently being uploaded even if it alone exceeds budget", () => {
    const gl = makeMockGl();
    const cache = new MeshBufferCache(1); // 極小予算
    const m = mesh(1024);
    const res = cache.getOrUpload(gl, m);
    expect(res).not.toBeNull();
    expect(cache.size()).toBe(1); // size>1 維持条件で自分は残る
    expect(aliveCount(gl)).toBe(3);
  });
});
