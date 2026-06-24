import { describe, expect, it } from "vitest";
import { sampleAny, sampleRgba } from "../src/runtime/interpolate";
import { staticProp, defaultTransform } from "../src/core/props";
import type { AnimatedProp, RGBA, SceneObject, TimelineComposition } from "../src/core/schema";
import { computeTextContentBounds, layoutGlyphsForDecompose, layoutTextLines, textBaselineY, textLineHeightPx } from "../src/runtime/textLayout";
import type { Font } from "opentype.js";
import { parseTextProps } from "../src/runtime/textRender";
import { buildGlyphDecomposeObjects, createFixedMeasureContext } from "../src/editor/glyphDecompose";
import { computeWorldTransforms } from "../src/editor/previewViewer";
import { vec3 } from "../src/core/props";

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

  // anchor 相対 align の契約（§26.4 整列バグ修正）。Draft/Precise レンダラは
  // テキスト要素を bounds.minX だけ local シフトして配置し、ギズモ bounds と一致させる。
  // この minX 符号がレンダラ配置とギズモの両方の唯一の正なのでロックする。
  it("computeTextContentBounds is anchor-relative for center/right align", () => {
    // 1 行 "AB", advance=10, tracking=0 → 行幅 20
    const left = computeTextContentBounds("AB", 10, 0, 0, "left", null, () => 10);
    expect(left.minX).toBe(0);
    expect(left.maxX).toBeCloseTo(20, 5);

    const center = computeTextContentBounds("AB", 10, 0, 0, "center", null, () => 10);
    expect(center.minX).toBeCloseTo(-10, 5); // anchor がボックス中央
    expect(center.maxX).toBeCloseTo(10, 5);

    const right = computeTextContentBounds("AB", 10, 0, 0, "right", null, () => 10);
    expect(right.minX).toBeCloseTo(-20, 5); // anchor がボックス右端
    expect(right.maxX).toBeCloseTo(0, 5);
  });
});

describe("box text + word wrap (§26.1 boxWidth)", () => {
  // 全文字幅 10px, tracking 0。boxWidth で折返す。
  const m = () => 10;

  it("boxWidth=0 keeps point text (no wrap)", () => {
    const lines = layoutTextLines("AAAA BBBB", 10, 0, 12, "left", null, m, 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("AAAA BBBB");
  });

  it("wraps at whitespace when line exceeds boxWidth", () => {
    // "AAAA BBBB" 各語幅 40。box=80 だと "AAAA BBBB" 全体は 90(40+10+40) で溢れる → 2 行。
    const lines = layoutTextLines("AAAA BBBB", 10, 0, 12, "left", null, m, 80);
    expect(lines.map((l) => l.text)).toEqual(["AAAA", "BBBB"]);
    expect(lines[1]!.y).toBe(12); // 2 行目は lineHeight ぶん下
  });

  it("breaks an over-long single token at char boundary", () => {
    // 1 語 "AAAAA" 幅 50, box=30 → 3/2 文字で割れる（最低 1 文字/行保証）
    const lines = layoutTextLines("AAAAA", 10, 0, 12, "left", null, m, 30);
    expect(lines.map((l) => l.text)).toEqual(["AAA", "AA"]);
  });

  it("box bounds use the box frame [0, boxWidth] not content", () => {
    const b = computeTextContentBounds("AAAA BBBB", 10, 0, 0, "left", null, m, 80);
    expect(b.minX).toBe(0);
    expect(b.maxX).toBe(80);
    expect(b.maxY).toBeCloseTo(2 * textLineHeightPx(10, 0), 5); // 2 行ぶん
  });

  it("center/right align within the box (boxWidth>0)", () => {
    // 行 "AAAA" 幅 40, box 80。center → +20, right → +40。
    const center = layoutTextLines("AAAA", 10, 0, 12, "center", null, m, 80);
    expect(center[0]!.glyphs[0]!.x).toBeCloseTo(20, 5);
    const right = layoutTextLines("AAAA", 10, 0, 12, "right", null, m, 80);
    expect(right[0]!.glyphs[0]!.x).toBeCloseTo(40, 5);
  });
});

describe("justify (§26.1)", () => {
  const m = () => 10;

  it("spreads inter-word space to fill the box on wrapped (non-last) lines", () => {
    // "AA BB CC" 幅: 3 語×20 + 2 空白×10 = 80。box=120 → extra 40 / 2 空白 = 20 each。
    const lines = layoutTextLines("AA BB CC", 10, 0, 12, "justify", null, m, 120);
    // 単一行（最終行扱い）なので justify されない → left のまま
    expect(lines).toHaveLength(1);
    expect(lines[0]!.glyphs[lines[0]!.glyphs.length - 1]!.x).toBeCloseTo(70, 5); // 最終行は詰め
  });

  it("justifies non-last wrapped lines, leaves last line ragged", () => {
    // box=70: "AA BB"(幅50) が 1 行目、"CC" が次行。1 行目=非最終→justify。
    // 1 行目 extra=(70-50)/1=20 を空白後の文字に加算。
    const lines = layoutTextLines("AA BB CC", 10, 0, 12, "justify", null, m, 70);
    expect(lines).toHaveLength(2);
    const g0 = lines[0]!.glyphs;
    expect(g0.map((g) => g.x)).toEqual([0, 10, 20, 50, 60]); // 空白(idx2)後の B,B が +20
    // 2 行目 "CC" は最終行 → left
    expect(lines[1]!.glyphs[0]!.x).toBe(0);
  });

  it("justify falls back to left when boxWidth=0", () => {
    const j = layoutTextLines("AA BB", 10, 0, 12, "justify", null, m, 0);
    const l = layoutTextLines("AA BB", 10, 0, 12, "left", null, m, 0);
    expect(j[0]!.glyphs.map((g) => g.x)).toEqual(l[0]!.glyphs.map((g) => g.x));
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
    const result = buildGlyphDecomposeObjects(obj, comp, 0, ctx, "keyframesOnNull");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4); // source + container + A + B
    expect(result![0]!.name).toBe("Text (source)");
    expect(result![0]!.enabled).toBe(false);
    expect((result![0]!.components[0]!.props["text"] as { value: string }).value).toBe("A B");
    expect(result![1]!.components[0]!.props["text"]).toEqual(staticProp(""));
    const glyphs = result!.slice(2);
    expect(glyphs.map((g) => (g.components[0]!.props["text"] as { value: string }).value)).toEqual(["A", "B"]);
  });

  it("child mode omits container and bakes transform keyframes", () => {
    const obj: SceneObject = {
      id: "01OBJ",
      name: "Text",
      parent: null,
      zOrder: 1,
      enabled: true,
      inPoint: 0,
      outPoint: 5,
      transform: {
        anchor: staticProp(vec3(0, 0, 0)),
        position: staticProp(vec3(0, 0, 0)),
        rotation: staticProp(vec3(0, 0, 0)),
        scale: staticProp(vec3(1, 1, 1)),
      },
      opacity: staticProp(1),
      components: [{
        type: "text",
        props: {
          text: staticProp("AB"),
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
    const result = buildGlyphDecomposeObjects(obj, comp, 0, ctx, "keyframesOnChild");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3); // source + A + B
    expect(result!.some((o) => o.id === "01OBJ")).toBe(false);
    const glyphs = result!.filter((o) => o.enabled);
    expect(glyphs).toHaveLength(2);
    expect(glyphs.every((g) => g.parent === null)).toBe(true);
    expect(glyphs[0]!.transform.position.keyframes).toHaveLength(5);
    expect(glyphs[1]!.transform.position.keyframes).toHaveLength(5);
  });

  it("child mode matches null mode world transforms", () => {
    const obj: SceneObject = {
      id: "01OBJ",
      name: "Text",
      parent: null,
      zOrder: 1,
      enabled: true,
      inPoint: 0,
      outPoint: 10,
      transform: {
        anchor: staticProp(vec3(0, 0, 0)),
        position: {
          value: vec3(0, 0, 0),
          keyframes: [
            { frame: 0, value: vec3(0, 0, 0), easing: lin },
            { frame: 9, value: vec3(100, 0, 0), easing: lin },
          ],
        },
        rotation: {
          value: vec3(0, 0, 0),
          keyframes: [
            { frame: 0, value: vec3(0, 0, 0), easing: lin },
            { frame: 9, value: vec3(0, 0, 45), easing: lin },
          ],
        },
        scale: staticProp(vec3(1, 1, 1)),
      },
      opacity: staticProp(1),
      components: [{
        type: "text",
        props: {
          text: staticProp("AB"),
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
    const nullResult = buildGlyphDecomposeObjects(obj, comp, 0, ctx, "keyframesOnNull")!;
    const childResult = buildGlyphDecomposeObjects(obj, comp, 0, ctx, "keyframesOnChild")!;

    const buildComp = (objects: SceneObject[]): TimelineComposition => ({ ...comp, objects });

    const glyphLayer = (o: SceneObject) =>
      o.enabled && o.components.some((c) => c.type === "text" && (c.props["text"] as { value: string }).value.length === 1);

    const nullGlyphs = nullResult.filter(glyphLayer);
    const childGlyphs = childResult.filter(glyphLayer);
    expect(nullGlyphs).toHaveLength(2);
    expect(childGlyphs).toHaveLength(2);

    for (const frame of [0, 3, 7, 9]) {
      const nullWorld = computeWorldTransforms(buildComp(nullResult), frame);
      const childWorld = computeWorldTransforms(buildComp(childResult), frame);
      for (let i = 0; i < 2; i++) {
        const nullChar = (nullGlyphs[i]!.components[0]!.props["text"] as { value: string }).value;
        const childIdx = childGlyphs.findIndex(
          (g) => (g.components[0]!.props["text"] as { value: string }).value === nullChar,
        );
        const nm = nullWorld.get(nullGlyphs[i]!.id)!;
        const cm = childWorld.get(childGlyphs[childIdx]!.id)!;
        for (let j = 0; j < 16; j++) {
          expect(cm[j]).toBeCloseTo(nm[j]!, 3);
        }
      }
    }
  });

  it("layoutGlyphsForDecompose skips whitespace", () => {
    const glyphs = layoutGlyphsForDecompose("A B", 10, 0, 0, "left", () => 10);
    expect(glyphs.map((g) => g.char)).toEqual(["A", "B"]);
    // 空白はレイヤー化しないが advance（10px）は B の x に反映される。
    expect(glyphs.map((g) => g.x)).toEqual([0, 20]);
  });

  it("layoutGlyphsForDecompose is anchor-relative like the renderer (center align)", () => {
    // §26.4 整列バグ修正後、グリフ絶対 local x = 生の g.x（center は負）。
    // "AB" 幅20, center → A@-10, B@0。分解はこの座標をそのまま使う（横ズレ防止）。
    const glyphs = layoutGlyphsForDecompose("AB", 10, 0, 0, "center", () => 10);
    expect(glyphs.map((g) => g.x)).toEqual([-10, 0]);
  });

  it("layoutGlyphsForDecompose preserves multiline y with explicit leading", () => {
    const glyphs = layoutGlyphsForDecompose("A\nB", 10, 0, 160, "left", () => 10);
    expect(glyphs[0]!.y).toBe(0);
    expect(glyphs[1]!.y).toBe(160);
  });

  it("layoutGlyphsForDecompose matches the renderer origin (anchor-relative, no minX renorm)", () => {
    const measure = (c: string) => (c === "A" ? 10 : 8);
    const glyphs = layoutGlyphsForDecompose("AB", 10, 0, 0, "center", measure);
    // line width 18, center offset -9 → A@-9, B@1（A advance 10）。
    expect(glyphs.map((g) => g.x)).toEqual([-9, 1]);
  });
});
