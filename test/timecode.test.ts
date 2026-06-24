import { describe, expect, it } from "vitest";
import { framesToTimecode, parseTimecode } from "../src/editor/timecode";

describe("framesToTimecode (§5.6 AE H:MM:SS:FF)", () => {
  it("formats whole seconds", () => {
    expect(framesToTimecode(150, 30)).toBe("0:00:05:00");
    expect(framesToTimecode(0, 30)).toBe("0:00:00:00");
  });

  it("keeps sub-second frames", () => {
    expect(framesToTimecode(45, 30)).toBe("0:00:01:15");
    expect(framesToTimecode(29, 30)).toBe("0:00:00:29");
  });

  it("rolls over minutes and hours", () => {
    expect(framesToTimecode(30 * 60, 30)).toBe("0:01:00:00");
    expect(framesToTimecode(30 * 3600, 30)).toBe("1:00:00:00");
    expect(framesToTimecode(30 * 3661 + 7, 30)).toBe("1:01:01:07");
  });

  it("depends on fps for the frame field", () => {
    expect(framesToTimecode(60, 60)).toBe("0:00:01:00");
    expect(framesToTimecode(60, 30)).toBe("0:00:02:00");
    expect(framesToTimecode(50, 24)).toBe("0:00:02:02");
  });

  it("clamps negatives and rounds non-integers", () => {
    expect(framesToTimecode(-5, 30)).toBe("0:00:00:00");
    expect(framesToTimecode(45.4, 30)).toBe("0:00:01:15");
  });

  it("guards fps <= 0", () => {
    expect(framesToTimecode(5, 0)).toBe("0:00:05:00");
  });
});

describe("parseTimecode (§5.6 right-aligned)", () => {
  it("parses full H:MM:SS:FF", () => {
    expect(parseTimecode("0:00:05:00", 30)).toBe(150);
    expect(parseTimecode("1:01:01:07", 30)).toBe(30 * 3661 + 7);
  });

  it("parses 3 / 2 / 1 segment forms", () => {
    expect(parseTimecode("00:05:00", 30)).toBe(150); // MM:SS:FF
    expect(parseTimecode("05:00", 30)).toBe(150); // SS:FF
    expect(parseTimecode("150", 30)).toBe(150); // raw frames
  });

  it("accepts ; (drop-frame style) as separator", () => {
    expect(parseTimecode("0;00;05;00", 30)).toBe(150);
  });

  it("carries overflow naturally", () => {
    expect(parseTimecode("0:00:00:45", 30)).toBe(45);
    expect(parseTimecode("0:00:04:30", 30)).toBe(150);
  });

  it("is fps-aware", () => {
    expect(parseTimecode("0:00:01:00", 60)).toBe(60);
    expect(parseTimecode("0:00:01:00", 24)).toBe(24);
  });

  it("rejects junk / negatives / too many segments", () => {
    expect(parseTimecode("", 30)).toBeNull();
    expect(parseTimecode("abc", 30)).toBeNull();
    expect(parseTimecode("-5", 30)).toBeNull();
    expect(parseTimecode("1:2:3:4:5", 30)).toBeNull();
    expect(parseTimecode("0:00:05:", 30)).toBeNull();
  });

  it("round-trips with framesToTimecode", () => {
    for (const fps of [24, 30, 60]) {
      for (const f of [0, 1, 29, 30, 150, 9999]) {
        expect(parseTimecode(framesToTimecode(f, fps), fps)).toBe(f);
      }
    }
  });
});
