// §3 プロジェクト構造のパス定数。FS / zip は全てこの構成を共有する (INV-4)。

export const PROJECT_JSON = "project.json";

export const DIR_ASSETS = "assets";
export const DIR_COMPOSITIONS = "compositions";
export const DIR_SCRIPTS = "scripts";
export const DIR_PRESETS = "presets";
export const DIR_PRESETS_EASING = "presets/easing";
export const DIR_PLUGINS = "plugins";

export function compositionDir(compId: string): string {
  return `${DIR_COMPOSITIONS}/${compId}`;
}

export function scriptPath(objectId: string, param: string): string {
  return `${DIR_SCRIPTS}/${objectId}/${param}.js`;
}

export function pluginDir(pluginId: string): string {
  return `${DIR_PLUGINS}/${pluginId}`;
}

export function pluginManifestPath(pluginId: string): string {
  return `${DIR_PLUGINS}/${pluginId}/plugin.json`;
}

export function pluginEntryPath(pluginId: string, entry: string): string {
  return `${DIR_PLUGINS}/${pluginId}/${entry}`;
}
