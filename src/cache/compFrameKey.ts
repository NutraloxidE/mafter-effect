import type { ResolutionProxy } from "../editor/previewViewer";

/** §28.3 コンポフレームキャッシュキー。 */
export function buildCompFrameCacheKey(params: {
  compId: string;
  frame: number;
  projectRevision: number;
  quality: "draft" | "precise";
  proxy: ResolutionProxy;
  width: number;
  height: number;
}): string {
  return [
    "comp",
    params.compId,
    `f${params.frame}`,
    `rev${params.projectRevision}`,
    `q${params.quality}`,
    `proxy${params.proxy}`,
    `w${params.width}`,
    `h${params.height}`,
  ].join(":");
}

export function compFrameCachePrefix(compId: string): string {
  return `comp:${compId}:`;
}

/** comp キーから frame 番号を抽出。 */
export function parseCompFrameFromKey(key: string): number | null {
  const m = /^comp:[^:]+:f(\d+):/.exec(key);
  return m ? Number(m[1]) : null;
}
