import type { MeshData } from "./geom3dTypes";

/**
 * §8（master-nested-composite-performance-plan Phase 3）WebGL mesh buffer 常駐 cache。
 *
 * 従来の `Geom3DGlState` は `lastMesh` 1 スロットしか持たないため、共有 canvas に mesh A→B→C… と
 * 描くたびに positions/normals/indices を毎 frame `bufferData()` で再 upload する（CPU mesh cache が
 * 効いても GPU 転送は減らない）。本 cache は context/canvas ごとに `MeshData` の identity を key として
 * GPU buffer bundle を常駐させ、warm frame の `bufferData` を 0 にする。
 *
 * 契約（§8.2 ガード）:
 * - hit → 既存 buffer を bind するだけ（upload 無し）
 * - miss → 生成 + upload + insert、byte 予算超過は LRU eviction（`deleteBuffer`）
 * - 描画中の mesh を誤 evict しない（挿入直後 = 最新 entry、eviction は最古から・size>1 を維持）
 * - `dispose()` で全 WebGLBuffer を明示解放（context loss / canvas release 時）
 * - 予算は runtime-only（project.json に追加しない）
 */

/** テスト可能な最小 GL インターフェース（WebGLRenderingContext が構造的に満たす）。 */
export interface MeshBufferGl {
  createBuffer(): WebGLBuffer | null;
  deleteBuffer(buffer: WebGLBuffer | null): void;
  bindBuffer(target: number, buffer: WebGLBuffer | null): void;
  bufferData(target: number, data: ArrayBufferView, usage: number): void;
  readonly ARRAY_BUFFER: number;
  readonly ELEMENT_ARRAY_BUFFER: number;
  readonly DYNAMIC_DRAW: number;
}

export interface GpuMeshBuffers {
  position: WebGLBuffer;
  normal: WebGLBuffer;
  index: WebGLBuffer;
  indexCount: number;
  byteSize: number;
}

/** upload 回数の外部観測（op-count ゲート用）。upload 1 回 = 3 回の `bufferData`。 */
export interface MeshBufferStats {
  bufferUploads: number;
}

function meshByteSize(m: MeshData): number {
  return m.positions.byteLength + m.normals.byteLength + m.indices.byteLength;
}

export class MeshBufferCache {
  private readonly map = new Map<MeshData, GpuMeshBuffers>();
  private bytes = 0;

  constructor(private readonly budgetBytes: number) {}

  /**
   * mesh に対応する常駐 buffer を返す。hit なら upload 無し、miss なら生成・upload・LRU eviction。
   * 生成に失敗した場合（`createBuffer` が null）は null を返し、呼び出し側はフォールバックする。
   */
  getOrUpload(gl: MeshBufferGl, mesh: MeshData, stats?: MeshBufferStats): GpuMeshBuffers | null {
    const hit = this.map.get(mesh);
    if (hit) {
      // LRU: 最近使用を末尾へ移動。
      this.map.delete(mesh);
      this.map.set(mesh, hit);
      return hit;
    }

    const position = gl.createBuffer();
    const normal = gl.createBuffer();
    const index = gl.createBuffer();
    if (!position || !normal || !index) {
      if (position) gl.deleteBuffer(position);
      if (normal) gl.deleteBuffer(normal);
      if (index) gl.deleteBuffer(index);
      return null;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, position);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, normal);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
    if (stats) stats.bufferUploads += 3;

    const byteSize = meshByteSize(mesh);
    const entry: GpuMeshBuffers = { position, normal, index, indexCount: mesh.indices.length, byteSize };
    this.map.set(mesh, entry);
    this.bytes += byteSize;

    // 予算超過は最古（Map 先頭）から eviction。挿入直後の entry（= 末尾）は size>1 維持で守られる。
    while (this.bytes > this.budgetBytes && this.map.size > 1) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const old = this.map.get(oldestKey);
      if (old) {
        gl.deleteBuffer(old.position);
        gl.deleteBuffer(old.normal);
        gl.deleteBuffer(old.index);
        this.bytes -= old.byteSize;
      }
      this.map.delete(oldestKey);
    }
    return entry;
  }

  /** 全 buffer を明示解放（context loss / canvas release / dispose）。 */
  dispose(gl: Pick<MeshBufferGl, "deleteBuffer">): void {
    for (const b of this.map.values()) {
      gl.deleteBuffer(b.position);
      gl.deleteBuffer(b.normal);
      gl.deleteBuffer(b.index);
    }
    this.map.clear();
    this.bytes = 0;
  }

  size(): number {
    return this.map.size;
  }

  byteSize(): number {
    return this.bytes;
  }
}
