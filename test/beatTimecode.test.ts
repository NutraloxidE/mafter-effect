import { describe, expect, it } from "vitest";
import { formatBarBeat, formatTimeWithBeat } from "../src/editor/beatTimecode";

describe("formatBarBeat (§21.1b Bar.Beat)", () => {
  it("120 BPM @ 30fps maps frames to bar.beat (1-based)", () => {
    // 120 BPM = 2 beats/sec → 1 beat = 15 frames @ 30fps.
    expect(formatBarBeat(0, 30, 120)).toBe("1.1");
    expect(formatBarBeat(15, 30, 120)).toBe("1.2");
    expect(formatBarBeat(30, 30, 120)).toBe("1.3");
    expect(formatBarBeat(45, 30, 120)).toBe("1.4");
    // beat 4 (frame 60) crosses into bar 2 — guards float error (4 % 4).
    expect(formatBarBeat(60, 30, 120)).toBe("2.1");
    expect(formatBarBeat(75, 30, 120)).toBe("2.2");
  });

  it("honors beatsPerBar", () => {
    // 3/4 time: bar wraps after 3 beats.
    expect(formatBarBeat(45, 30, 120, 3)).toBe("2.1");
    expect(formatBarBeat(30, 30, 120, 3)).toBe("1.3");
  });

  it("defaults beatsPerBar to 4", () => {
    expect(formatBarBeat(60, 30, 120)).toBe(formatBarBeat(60, 30, 120, 4));
  });

  it("returns null for non-positive / non-finite bpm", () => {
    expect(formatBarBeat(60, 30, 0)).toBeNull();
    expect(formatBarBeat(60, 30, -120)).toBeNull();
    expect(formatBarBeat(60, 30, NaN)).toBeNull();
  });

  it("clamps negative frames and rounds fps", () => {
    expect(formatBarBeat(-10, 30, 120)).toBe("1.1");
    expect(formatBarBeat(60, 29.97, 120)).toBe("2.1"); // fps rounds to 30
  });
});

describe("formatTimeWithBeat (§21.1b companion display)", () => {
  it("appends Bar.Beat when bpm > 0", () => {
    expect(formatTimeWithBeat(45, 30, 120)).toBe("0:00:01:15 · 1.4");
    expect(formatTimeWithBeat(60, 30, 120)).toBe("0:00:02:00 · 2.1");
  });

  it("falls back to timecode only when bpm is undefined / 0", () => {
    expect(formatTimeWithBeat(45, 30, undefined)).toBe("0:00:01:15");
    expect(formatTimeWithBeat(45, 30, 0)).toBe("0:00:01:15");
  });
});
