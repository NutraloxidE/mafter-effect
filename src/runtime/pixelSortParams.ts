import type { PixelSortMode, PixelSortParams } from "./pixelSort";

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

export function parsePixelSortParams(props: Record<string, unknown>): PixelSortParams {
  const mode = str(props["sortingMode"], "simple");
  const sortingMode: PixelSortMode =
    mode === "highlights" || mode === "shadows" || mode === "random" ? mode : "simple";
  return {
    sortingMode,
    thresholdLow: Math.min(1, Math.max(0, num(props["thresholdLow"], 0.25))),
    thresholdHigh: Math.min(1, Math.max(0, num(props["thresholdHigh"], 0.75))),
    angle: num(props["angle"], 0),
    length: Math.max(0, Math.round(num(props["length"], 256))),
    offset: Math.max(0, Math.round(num(props["offset"], 0))),
    feather: Math.max(0, num(props["feather"], 0)),
    sortBlocks: Math.max(1, Math.min(64, Math.round(num(props["sortBlocks"], 1)))),
  };
}
