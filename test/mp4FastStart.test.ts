import { afterEach, describe, expect, it } from "vitest";
import { isAudioMixOverlapEnabled, resolveMp4FastStart } from "../src/runtime/exporter";

describe("resolveMp4FastStart", () => {
  afterEach(() => {
    delete (globalThis as { __mafterMp4ReservedFastStart?: unknown }).__mafterMp4ReservedFastStart;
    delete (globalThis as { __mafterAudioMixOverlap?: unknown }).__mafterAudioMixOverlap;
  });

  it("reserves bounded regular-MP4 metadata by default", () => {
    expect(resolveMp4FastStart(60, false, 2)).toEqual({ expectedVideoChunks: 60 });
    expect(resolveMp4FastStart(60, true, 2)).toEqual({
      expectedVideoChunks: 60,
      expectedAudioChunks: 95,
    });
  });

  it("keeps an A/B fallback to the former in-memory mode", () => {
    (globalThis as { __mafterMp4ReservedFastStart?: unknown }).__mafterMp4ReservedFastStart = false;
    expect(resolveMp4FastStart(60, true, 2)).toBe("in-memory");
  });
});

describe("audio mix overlap feature gate", () => {
  afterEach(() => {
    delete (globalThis as { __mafterAudioMixOverlap?: unknown }).__mafterAudioMixOverlap;
  });

  it("stays off by default after a resource-contention regression", () => {
    expect(isAudioMixOverlapEnabled()).toBe(false);
    (globalThis as { __mafterAudioMixOverlap?: unknown }).__mafterAudioMixOverlap = true;
    expect(isAudioMixOverlapEnabled()).toBe(true);
  });
});
