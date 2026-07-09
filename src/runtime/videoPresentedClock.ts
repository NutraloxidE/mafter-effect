type PresentedVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

interface PresentedClockState {
  handle: number | null;
  mediaTimeSec: number | null;
}

const presentedClocks = new WeakMap<HTMLVideoElement, PresentedClockState>();

export function attachPresentedClock(video: HTMLVideoElement): void {
  const v = video as PresentedVideo;
  if (!v.requestVideoFrameCallback || presentedClocks.has(video)) return;
  const state: PresentedClockState = { handle: null, mediaTimeSec: null };
  const tick: VideoFrameRequestCallback = (_now, meta) => {
    state.mediaTimeSec = Number.isFinite(meta.mediaTime) ? meta.mediaTime : null;
    state.handle = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(tick) : null;
  };
  state.handle = v.requestVideoFrameCallback(tick);
  presentedClocks.set(video, state);
}

export function detachPresentedClock(video: HTMLVideoElement): void {
  const state = presentedClocks.get(video);
  if (!state) return;
  const v = video as PresentedVideo;
  if (state.handle !== null && v.cancelVideoFrameCallback) {
    try {
      v.cancelVideoFrameCallback(state.handle);
    } catch {
      /* cancel best-effort */
    }
  }
  presentedClocks.delete(video);
}

export function getPresentedMediaTimeSec(video: HTMLVideoElement): number | null {
  return presentedClocks.get(video)?.mediaTimeSec ?? null;
}
