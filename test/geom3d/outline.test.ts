import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseFont, type Font } from "opentype.js";
import { describe, expect, it } from "vitest";
import { flattenPathCommandsToRings, textToOutlineGlyphs } from "../../src/runtime/geom3d/outlineProvider";

function loadFont(): Font {
  const buf = readFileSync(path.resolve(__dirname, "../../public/fonts/NotoSans-Regular.ttf"));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return parseFont(ab);
}

describe("flattenPathCommandsToRings", () => {
  it("returns a single ring for a straight-line-only closed path (triangle)", () => {
    const rings = flattenPathCommandsToRings(
      [
        { type: "M", x: 0, y: 0 },
        { type: "L", x: 10, y: 0 },
        { type: "L", x: 5, y: 10 },
        { type: "Z" },
      ],
      8,
    );
    expect(rings.length).toBe(1);
    expect(rings[0]!.length).toBe(3);
    expect(rings[0]![0]).toEqual({ x: 0, y: 0 });
  });

  it("splits multiple M subpaths into separate rings (glyph holes)", () => {
    const rings = flattenPathCommandsToRings(
      [
        { type: "M", x: 0, y: 0 },
        { type: "L", x: 10, y: 0 },
        { type: "L", x: 10, y: 10 },
        { type: "Z" },
        { type: "M", x: 3, y: 3 },
        { type: "L", x: 7, y: 3 },
        { type: "L", x: 7, y: 7 },
        { type: "Z" },
      ],
      8,
    );
    expect(rings.length).toBe(2);
  });

  it("flattens a cubic bezier into `segmentsPerCurve` additional points, deterministically", () => {
    const commands = [
      { type: "M" as const, x: 0, y: 0 },
      { type: "C" as const, x1: 0, y1: 10, x2: 10, y2: 10, x: 10, y: 0 },
      { type: "L" as const, x: 5, y: -5 },
      { type: "Z" as const },
    ];
    const a = flattenPathCommandsToRings(commands, 8);
    const b = flattenPathCommandsToRings(commands, 8);
    expect(a).toEqual(b); // 決定論
    // M(1) + C(8 points) + L(1) = 10
    expect(a[0]!.length).toBe(10);
  });

  it("higher segmentsPerCurve yields more points on curved commands", () => {
    const commands = [
      { type: "M" as const, x: 0, y: 0 },
      { type: "C" as const, x1: 0, y1: 10, x2: 10, y2: 10, x: 10, y: 0 },
      { type: "Z" as const },
    ];
    const low = flattenPathCommandsToRings(commands, 4);
    const high = flattenPathCommandsToRings(commands, 32);
    expect(high[0]!.length).toBeGreaterThan(low[0]!.length);
  });
});

describe("textToOutlineGlyphs", () => {
  const font = loadFont();

  it("produces one or more OutlineGlyph per non-space character", () => {
    const result = textToOutlineGlyphs(
      { text: "AB", size: 48, tracking: 0, leading: 0, align: "left", boxWidth: 0, boxHeight: 0 },
      font,
      16,
    );
    expect(result).not.toBeNull();
    expect(result!.glyphs.length).toBe(2);
    for (const g of result!.glyphs) {
      expect(g.rings.length).toBeGreaterThan(0);
    }
  });

  it("produces multiple rings for a glyph with a hole (e.g. 'O')", () => {
    const result = textToOutlineGlyphs(
      { text: "O", size: 48, tracking: 0, leading: 0, align: "left", boxWidth: 0, boxHeight: 0 },
      font,
      16,
    );
    expect(result).not.toBeNull();
    expect(result!.glyphs[0]!.rings.length).toBeGreaterThanOrEqual(2);
  });

  it("skips whitespace characters (no glyph emitted)", () => {
    const result = textToOutlineGlyphs(
      { text: "A B", size: 48, tracking: 0, leading: 0, align: "left", boxWidth: 0, boxHeight: 0 },
      font,
      16,
    );
    expect(result!.glyphs.length).toBe(2);
  });

  it("is deterministic for identical input (INV-1)", () => {
    const input = { text: "Test", size: 32, tracking: 2, leading: 0, align: "left" as const, boxWidth: 0, boxHeight: 0 };
    const a = textToOutlineGlyphs(input, font, 16);
    const b = textToOutlineGlyphs(input, font, 16);
    expect(a).toEqual(b);
  });

  it("returns positive width/height bounds matching multi-glyph content", () => {
    const single = textToOutlineGlyphs(
      { text: "A", size: 48, tracking: 0, leading: 0, align: "left", boxWidth: 0, boxHeight: 0 },
      font,
      16,
    )!;
    const double = textToOutlineGlyphs(
      { text: "AA", size: 48, tracking: 0, leading: 0, align: "left", boxWidth: 0, boxHeight: 0 },
      font,
      16,
    )!;
    expect(double.width).toBeGreaterThan(single.width);
    expect(single.height).toBeGreaterThan(0);
  });
});
