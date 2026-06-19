/// <reference lib="webworker" />

import { processPixelSort, type PixelSortParams } from "../pixelSort";
import type { RasterBuffer } from "../plugin";

export interface RasterProcessRequest {
  id: number;
  input: RasterBuffer;
  params: PixelSortParams;
  seed: number;
}

export interface RasterProcessResponse {
  id: number;
  output?: RasterBuffer;
  error?: string;
}

self.onmessage = (ev: MessageEvent<RasterProcessRequest>) => {
  const { id, input, params, seed } = ev.data;
  try {
    const data = new Uint8ClampedArray(input.data);
    const output = processPixelSort({ data, width: input.width, height: input.height }, params, seed);
    const res: RasterProcessResponse = { id, output };
    self.postMessage(res, [output.data.buffer]);
  } catch (e) {
    const res: RasterProcessResponse = { id, error: e instanceof Error ? e.message : String(e) };
    self.postMessage(res);
  }
};
