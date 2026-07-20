export interface EncoderQueueLike extends EventTarget {
  readonly encodeQueueSize: number;
  readonly state: "unconfigured" | "configured" | "closed";
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Export aborted", "AbortError");
}

/** Waits without polling until the encoder can accept another bounded input frame. */
export async function waitForEncoderQueueAtMost(
  encoder: EncoderQueueLike,
  maxQueue: number,
  signal?: AbortSignal,
): Promise<void> {
  while (encoder.encodeQueueSize > maxQueue) {
    if (signal?.aborted) throw abortError(signal);
    if (encoder.state === "closed") throw new Error("VideoEncoder closed while waiting for backpressure");

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        encoder.removeEventListener("dequeue", onDequeue);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onDequeue = () => settle(resolve);
      const onAbort = () => settle(() => reject(abortError(signal!)));

      encoder.addEventListener("dequeue", onDequeue, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });

      // The UA may drain the codec queue between the outer check and listener registration.
      if (encoder.encodeQueueSize <= maxQueue) settle(resolve);
      else if (encoder.state === "closed") {
        settle(() => reject(new Error("VideoEncoder closed while waiting for backpressure")));
      } else if (signal?.aborted) {
        settle(() => reject(abortError(signal)));
      }
    });
  }
}
