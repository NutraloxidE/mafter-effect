/// <reference lib="webworker" />

export interface PngEncodeRequest {
  id: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface PngEncodeResponse {
  id: number;
  png?: Uint8Array;
  error?: string;
}

self.onmessage = async (ev: MessageEvent<PngEncodeRequest>) => {
  const { id, width, height, rgba } = ev.data;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const png = new Uint8Array(await blob.arrayBuffer());
    const res: PngEncodeResponse = { id, png };
    self.postMessage(res, [png.buffer]);
  } catch (e) {
    const res: PngEncodeResponse = { id, error: e instanceof Error ? e.message : String(e) };
    self.postMessage(res);
  }
};
