/// <reference lib="webworker" />

// Phase 2b（preview-rendering-pipeline-optimization-plan）: 動画バイナリの Blob 構築を
// メインスレッド外へオフロードする。URL.createObjectURL はここでは呼ばない — worker で
// 発行した blob: URL はメインスレッドの <video src> から参照できず失効するため（呼び出し元
// videoBlobDecode.ts のコメント参照）。Worker は Blob オブジェクトそのものを返すだけに留める。

export interface VideoBlobRequest {
  id: number;
  buffer: ArrayBuffer;
  mime: string;
}

export interface VideoBlobResponse {
  id: number;
  blob?: Blob;
  error?: string;
}

self.onmessage = (ev: MessageEvent<VideoBlobRequest>) => {
  const { id, buffer, mime } = ev.data;
  try {
    // buffer は transfer 済み（コピーゼロ）。
    const blob = new Blob([buffer], { type: mime });
    const res: VideoBlobResponse = { id, blob };
    self.postMessage(res);
  } catch (e) {
    const res: VideoBlobResponse = { id, error: e instanceof Error ? e.message : String(e) };
    self.postMessage(res);
  }
};
