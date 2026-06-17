import { describe, expect, it } from "vitest";
import { sampleAny, sampleRgba } from "../src/runtime/interpolate";
import { staticProp, defaultTransform } from "../src/core/props";
import type { AnimatedProp, RGBA, SceneObject, TimelineComposition } from "../src/core/schema";
import { computeTextContentBounds, layoutGlyphsForDecompose, layoutTextLines, textBaselineY, textLineHeightPx } from "../src/runtime/textLayout";
import type { Font } from "opentype.js";
import { parseTextProps } from "../src/runtime/textRender";
import { buildGlyphDecomposeObjects, createFixedMeasureContext } from "../src/editor/glyphDecompose";

const lin = { type: "linear" as const };

describe("sampleRgba", () => {
  it("interpolates RGBA components", () => {
    const p: AnimatedProp<RGBA> = {
      value: { r: 0, g: 0, b: 0, a: 1 },
      keyframes: [
        { frame: 0, value: { r: 0, g: 0, b: 0, a: 0 }, easing: lin },
        { frame: 10, value: { r: 1, g: 1, b: 1, a: 1 }, easing: lin },
      ],
    };
    const mid = sampleRgba(p, 5);
    expect(mid.r).toBeCloseTo(0.5, 5);
    expect(mid.a).toBeCloseTo(0.5, 5);
  });

  it("sampleAny uses rgba interpolation for color props", () => {
    const p: AnimatedProp<RGBA> = {
      value: { r: 0, g: 0, b: 0, a: 1 },
      keyframes: [
        { frame: 0, value: { r: 0, g: 0, b: 0, a: 1 }, easing: lin },
        { frame: 10, value: { r: 1, g: 0, b: 0, a: 1 }, easing: lin },
      ],
    };
    const mid = sampleAny(p, 5) as RGBA;
    expect(mid.r).toBeCloseTo(0.5, 5);
  });
});

describe("parseTextProps", () => {
  it("applies §26.1 defaults", () => {
    const p = parseTextProps({ text: "Hi", size: 24 });
    expect(p.text).toBe("Hi");
    expect(p.size).toBe(24);
    expect(p.tracking).toBe(0);
    expect(p.strokeWidth).toBe(0);
    expect(p.weight).toBe(400);
  });
});

describe("layoutTextLines", () => {
  it("lays out multiple lines with tracking", () => {
    const lines = layoutTextLines("AB\nC", 10, 2, 12, "left", null, () => 10);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.glyphs).toHaveLength(2);
    expect(lines[0]!.glyphs[1]!.x).toBe(12);
    expect(lines[1]!.text).toBe("C");
  });

  it("centers line with align center", () => {
    const lines = layoutTextLines("AB", 10, 0, 12, "center", null, () => 10);
    expect(lines[0]!.glyphs[0]!.x).toBe(-10);
    expect(lines[0]!.glyphs[1]!.x).toBe(0);
  });

  it("computeTextContentBounds matches layout (left align)", () => {
    const b = computeTextContentBounds("AB", 10, 0, 0, "left", null);
    expect(b.minX).toBe(0);
    expect(b.maxX).toBeCloseTo(12, 5);
    expect(b.maxY).toBeCloseTo(textLineHeightPx(10, 0), 5);
  });
});

describe("textBaselineY (§26.4 Draft/Best baseline 一致)", () => {
  // CSS line-box の baseline 配置に一致させる:
  //   baseline = (line-height - (ascent + descent)) / 2 + ascent
  // ascent/descent はフォントメトリクス。インク高さ(actualBoundingBox)で代用してはならない。
  const fakeFont = { unitsPerEm: 1000, ascender: 800, descender: -200 } as unknown as Font;

  it("uses font metrics + half-leading, not ink ascent", () => {
    // size=100, leading=0 → lh=120, ascent=80, descent=20, fontHeight=100
    // halfLeading=(120-100)/2=10, baseline=0+10+80=90
    expect(textBaselineY(0, 100, 0, fakeFont)).toBeCloseTo(90, 5);
  });

  it("explicit leading sets line-height directly", () => {
    // leading=160 → lh=160, halfLeading=(160-100)/2=30, baseline=30+80=110
    expect(textBaselineY(0, 100, 160, fakeFont)).toBeCloseTo(110, 5);
  });

  it("offsets by lineY for subsequent lines", () => {
    expect(textBaselineY(120, 100, 0, fakeFont)).toBeCloseTo(210, 5);
  });
});

describe("glyph decompose", () => {
  const comp: TimelineComposition = {
    id: "01COMP",
    name: "Test",
    kind: "timeline",
    width: 100,
    height: 100,
    fps: 30,
    duration: 30,
    objects: [],
  };

  it("creates one object per non-space glyph", () => {
    const obj: SceneObject = {
      id: "01OBJ",
      name: "Text",
      parent: null,
      zOrder: 1,
      enabled: true,
      inPoint: 0,
      outPoint: 30,
      transform: defaultTransform(),
      opacity: staticProp(1),
      components: [{
        type: "text",
        props: {
          text: staticProp("A B"),
          size: staticProp(10),
          color: staticProp({ r: 1, g: 1, b: 1, a: 1 }),
          tracking: staticProp(0),
          leading: staticProp(0),
          strokeColor: staticProp({ r: 0, g: 0, b: 0, a: 1 }),
          strokeWidth: staticProp(0),
          font: "sans-serif",
          align: "left",
          weight: 400,
          italic: false,
        },
      }],
    };
    const ctx = createFixedMeasureContext(10);
    const result = buildGlyphDecomposeObjects(obj, comp, 0, ctx);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3); // container + A + B
    expect(result![0]!.components[0]!.props["text"]).toEqual(staticProp(""));
    const glyphs = result!.slice(1);
    expect(glyphs.map((g) => (g.components[0]!.props["text"] as { value: string }).value)).toEqual(["A", "B"]);
  });

  it("layoutGlyphsForDecompose skips whitespace", () => {
    const glyphs = layoutGlyphsForDecompose("A B", 10, 0, 0, "left", () => 10);
    expect(glyphs.map((g) => g.char)).toEqual(["A", "B"]);
  });
});
