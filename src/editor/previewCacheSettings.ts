const STORAGE_KEY = "mafter-preview-cache-v1";

export interface PreviewCacheSettings {
  enabled: boolean;
  maxRamMB: number;
  enableDiskCache: boolean;
  /** 将来デスクトップのみ。Web では無視。 */
  cacheRootPath?: string;
}

export const DEFAULT_PREVIEW_CACHE_SETTINGS: PreviewCacheSettings = {
  enabled: true,
  maxRamMB: 256,
  enableDiskCache: true,
};

export function loadPreviewCacheSettings(): PreviewCacheSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_PREVIEW_CACHE_SETTINGS, ...(JSON.parse(raw) as Partial<PreviewCacheSettings>) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_PREVIEW_CACHE_SETTINGS };
}

export function savePreviewCacheSettings(settings: PreviewCacheSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}
