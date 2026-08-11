import type { RenderProfile, SwarmRenderResult } from "./types";

export interface RenderCacheKeyInput {
  renderRevision: string;
  compositionId: string;
  frame: number;
  profile: RenderProfile;
  runtimeVersion: string;
  assetHashes?: Record<string, string>;
}

export function buildSwarmRenderCacheKey(input: RenderCacheKeyInput): string {
  const assets = Object.entries(input.assetHashes ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, hash]) => `${path}=${hash}`)
    .join(",");
  return [
    "swarm",
    input.renderRevision,
    input.compositionId,
    `f${input.frame}`,
    input.profile.quality,
    input.profile.proxy,
    `w${input.profile.width}`,
    `h${input.profile.height}`,
    input.runtimeVersion,
    assets,
  ].join(":");
}

export function validateSwarmRenderResult(
  result: SwarmRenderResult,
  expected: RenderCacheKeyInput & { jobId: string },
): boolean {
  return result.jobId === expected.jobId
    && result.renderRevision === expected.renderRevision
    && result.compositionId === expected.compositionId
    && result.frameStart === expected.frame
    && result.frameEnd > result.frameStart
    && result.width === expected.profile.width
    && result.height === expected.profile.height
    && (result.format === "png" || result.format === "png-zip")
    && result.runtimeVersion === expected.runtimeVersion
    && result.byteLength > 0
    && result.byteLength <= 256 * 1024 * 1024;
}
