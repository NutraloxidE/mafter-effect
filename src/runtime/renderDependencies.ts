import type { Component, Project } from "../core/schema";
import { resolveFootageAudioPath, resolveFootageVideoPath } from "./footagePlayback";
import { effectivePackedQuality, normalizeFootageQuality, normalizePackedPreviewSelection } from "./footageQuality";
import { isPackedAlphaVideoMeta, isSplitAlphaVideoMeta } from "./imageAssetCache";

/**
 * Which file a footage layer actually reads depends on the layer's `footageQuality`, on whether the
 * asset is packed alpha (whose effective tier differs between live playback and a deterministic
 * export), and on companions the asset table names but no prop does. Knowing an asset's id is
 * therefore not the same as knowing its path.
 *
 * Two callers must agree on that resolution: the bundle, which zips the files a player will fetch,
 * and the swarm, which ships the files a worker will read. When they disagreed, the swarm sent an
 * asset id's own path and the worker's renderer asked for a proxy that had never travelled — an
 * unresolvable URL, hunted for a session as if it were a decode bug. One definition of "the files
 * this render needs", parameterized by the one thing that genuinely differs.
 */
export interface RenderDependencyOptions {
  /**
   * True for a deterministic export (`exportVideoStep`), which resolves a packed-alpha layer
   * through its own Export Quality; false for live playback, which uses the preview selection.
   */
  exportStep: boolean;
}

/** Files the renderer will read for this component, given how it will be driven. */
export function footagePathsForComponent(
  project: Project,
  component: Component,
  options: RenderDependencyOptions,
): string[] {
  if (component.type !== "video") return [];
  const assetId = component.props["asset"];
  if (typeof assetId !== "string") return [];
  const asset = project.assets.find((candidate) => candidate.id === assetId);
  if (!asset) return [];

  const quality = isPackedAlphaVideoMeta(asset.meta)
    ? effectivePackedQuality(normalizePackedPreviewSelection(component.props["footageQuality"]), {
        exportStep: options.exportStep,
        exportQuality: normalizeFootageQuality(component.props["packedExportQuality"]),
      })
    : normalizeFootageQuality(component.props["footageQuality"]);

  const paths = [resolveFootageVideoPath(asset, quality)];
  // Embedded audio always plays from the original, whatever tier the picture came from.
  const audioPath = resolveFootageAudioPath(asset);
  if (audioPath) paths.push(audioPath);
  // A split-alpha mask is quality-independent: `getAlphaVideoUrl` never consults the tier.
  if (isSplitAlphaVideoMeta(asset.meta)) paths.push(asset.meta!.alphaPath as string);
  return paths;
}
