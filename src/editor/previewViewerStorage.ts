import type { ResolutionProxy, ViewPan, ZoomMode } from "./previewViewer";

const STORAGE_KEY = "mafter-preview-viewer-v1";

export interface PreviewViewerSettings {
  zoomMode: ZoomMode;
  viewZoom: number;
  viewPan: ViewPan;
  checkerboard: boolean;
  safeMargins: boolean;
  grid: boolean;
  centerCross: boolean;
  rulers: boolean;
  resolutionProxy: ResolutionProxy;
  loop: boolean;
}

export const DEFAULT_VIEWER_SETTINGS: PreviewViewerSettings = {
  zoomMode: "fit",
  viewZoom: 1,
  viewPan: { x: 0, y: 0 },
  checkerboard: true,
  safeMargins: false,
  grid: false,
  centerCross: false,
  rulers: false,
  resolutionProxy: "full",
  loop: false,
};

type SettingsByComp = Record<string, Partial<PreviewViewerSettings>>;

function readAll(): SettingsByComp {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as SettingsByComp;
  } catch {
    /* ignore */
  }
  return {};
}

function writeAll(data: SettingsByComp): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

/** §25.7 comp ごとのビューア設定を読み込む（project.json 非汚染）。 */
export function loadViewerSettings(compId: string): PreviewViewerSettings {
  const all = readAll();
  const saved = all[compId];
  const settings: PreviewViewerSettings = { ...DEFAULT_VIEWER_SETTINGS, ...saved };
  // §25.2 Half/Quarter プロキシは未実装。過去の localStorage 値は Full に正規化する。
  if (settings.resolutionProxy !== "full") {
    settings.resolutionProxy = "full";
  }
  return settings;
}

/** §25.7 comp ごとのビューア設定を保存する。 */
export function saveViewerSettings(compId: string, patch: Partial<PreviewViewerSettings>): void {
  const all = readAll();
  all[compId] = { ...all[compId], ...patch };
  writeAll(all);
}
