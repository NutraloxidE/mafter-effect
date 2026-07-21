import type { AssetEntry, Project } from "../core/schema";

export function assetFilePaths(asset: AssetEntry): string[] {
  const paths = new Set<string>([asset.path]);
  if (typeof asset.meta?.["originalPath"] === "string") paths.add(asset.meta["originalPath"] as string);
  const proxies = asset.meta?.["proxies"];
  if (proxies && typeof proxies === "object") {
    for (const raw of Object.values(proxies as Record<string, unknown>)) {
      const path = (raw as { path?: unknown })?.path;
      if (typeof path === "string") paths.add(path);
    }
  }
  return [...paths];
}

/** Files owned by target asset that are not shared by another Project asset entry. */
export function unreferencedAssetFilePaths(project: Project, assetId: string): string[] {
  const target = project.assets.find((asset) => asset.id === assetId);
  if (!target) return [];
  const retained = new Set(
    project.assets
      .filter((asset) => asset.id !== assetId)
      .flatMap(assetFilePaths),
  );
  return assetFilePaths(target).filter((path) => !retained.has(path));
}
