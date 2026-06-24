import { newObjectId } from "../core/ids";
import { staticProp } from "../core/props";
import type { AnimatedProp, Component, EffectInstance, Frame, RGBA, SceneObject, TimelineComposition } from "../core/schema";
import { sampleAny } from "../runtime/interpolate";
import type { ResolveContext } from "../runtime/resolve";
import { layoutGlyphsForDecompose, type TextAlign } from "../runtime/textLayout";
import { bakeGlyphTransform, cloneAnimatedProp, collectIntegerFrames } from "./glyphBake";

export type GlyphDecomposeMode = "keyframesOnNull" | "keyframesOnChild";

export interface GlyphMeasureContext {
  measureChar: (char: string) => number;
}

export interface GlyphDecomposeStyle {
  font: string;
  align: TextAlign;
  weight: number;
  italic: boolean;
  size: number;
  tracking: number;
  leading: number;
  boxWidth: number;
  color: RGBA;
  strokeColor: RGBA;
  strokeWidth: number;
}

function readStatic<T>(props: Record<string, unknown>, key: string, fallback: T): T {
  const v = props[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v === "object" && v !== null && "value" in v && "keyframes" in v) {
    return (v as { value: T }).value;
  }
  return v as T;
}

function readAnimatedString(props: Record<string, unknown>, key: string, frame: Frame, fallback: string): string {
  const v = sampleAny(props[key], frame);
  return typeof v === "string" ? v : fallback;
}

function readAnimatedNumber(props: Record<string, unknown>, key: string, frame: Frame, fallback: number): number {
  const v = sampleAny(props[key], frame);
  return typeof v === "number" ? v : fallback;
}

function readAnimatedRgba(props: Record<string, unknown>, key: string, frame: Frame, fallback: RGBA): RGBA {
  const v = sampleAny(props[key], frame);
  if (typeof v === "object" && v !== null && "r" in v) return v as RGBA;
  return fallback;
}

function readDecomposeStyle(
  props: Record<string, unknown>,
  frame: Frame,
): GlyphDecomposeStyle {
  return {
    font: readStatic(props, "font", "sans-serif"),
    align: readStatic(props, "align", "left") as TextAlign,
    weight: readStatic(props, "weight", 400),
    italic: readStatic(props, "italic", false),
    size: readAnimatedNumber(props, "size", frame, 48),
    tracking: readAnimatedNumber(props, "tracking", frame, 0),
    leading: readAnimatedNumber(props, "leading", frame, 0),
    boxWidth: readAnimatedNumber(props, "boxWidth", frame, 0),
    color: readAnimatedRgba(props, "color", frame, { r: 1, g: 1, b: 1, a: 1 }),
    strokeColor: readAnimatedRgba(props, "strokeColor", frame, { r: 0, g: 0, b: 0, a: 1 }),
    strokeWidth: readAnimatedNumber(props, "strokeWidth", frame, 0),
  };
}

function isAnimatedProp(v: unknown): v is AnimatedProp<unknown> {
  return typeof v === "object" && v !== null && "value" in v && "keyframes" in v;
}

function cloneComponentProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(props)) {
    if (isAnimatedProp(val)) {
      out[key] = cloneAnimatedProp(val);
    } else {
      out[key] = structuredClone(val);
    }
  }
  return out;
}

function cloneEffectsForGlyph(effects: EffectInstance[] | undefined): EffectInstance[] | undefined {
  if (!effects || effects.length === 0) return undefined;
  return effects.map((e) => ({
    ...e,
    id: newObjectId(),
    props: cloneComponentProps(e.props),
  }));
}

function buildGlyphTextComponent(
  char: string,
  style: GlyphDecomposeStyle,
  sourceProps: Record<string, unknown>,
): Component {
  const props = cloneComponentProps(sourceProps);
  props["text"] = staticProp(char);
  props["tracking"] = staticProp(0);
  props["align"] = "left";
  props["font"] = style.font;
  props["weight"] = style.weight;
  props["italic"] = style.italic;
  if (!isAnimatedProp(props["size"])) props["size"] = staticProp(style.size);
  if (!isAnimatedProp(props["leading"])) props["leading"] = staticProp(style.leading);
  if (!isAnimatedProp(props["color"])) props["color"] = staticProp(style.color);
  if (!isAnimatedProp(props["strokeColor"])) props["strokeColor"] = staticProp(style.strokeColor);
  if (!isAnimatedProp(props["strokeWidth"])) props["strokeWidth"] = staticProp(style.strokeWidth);
  return { type: "text", props };
}

interface GlyphPlacement {
  char: string;
  x: number;
  y: number;
}

function buildGlyphObjectBase(
  obj: SceneObject,
  g: GlyphPlacement,
  z: number,
  style: GlyphDecomposeStyle,
  sourceProps: Record<string, unknown>,
  parent: string | null,
  transform: SceneObject["transform"],
): SceneObject {
  return {
    id: newObjectId(),
    name: `${obj.name} ${g.char}`,
    parent,
    zOrder: z,
    enabled: true,
    inPoint: obj.inPoint,
    outPoint: obj.outPoint,
    transform,
    opacity: cloneAnimatedProp(obj.opacity),
    components: [buildGlyphTextComponent(g.char, style, sourceProps)],
    effects: cloneEffectsForGlyph(obj.effects),
  };
}

/** §26.5 グリフ分解: 1 command で複数 SceneObject を生成する patch を作る。 */
export function buildGlyphDecomposeObjects(
  obj: SceneObject,
  comp: TimelineComposition,
  frame: Frame,
  ctx: GlyphMeasureContext,
  mode: GlyphDecomposeMode = "keyframesOnNull",
  resolveCtx?: ResolveContext,
): SceneObject[] | null {
  const textCompIdx = obj.components.findIndex((c) => c.type === "text");
  if (textCompIdx < 0) return null;
  const textComp = obj.components[textCompIdx]!;
  const props = textComp.props;

  const sourceText = readAnimatedString(props, "text", frame, "");
  if (!sourceText) return null;

  const style = readDecomposeStyle(props, frame);
  const placements = layoutGlyphsForDecompose(
    sourceText,
    style.size,
    style.tracking,
    style.leading,
    style.align,
    ctx.measureChar,
    style.boxWidth,
  );
  if (placements.length === 0) return null;

  const sourceLayer = preserveDecomposeSourceLayer(obj);
  const baseZ = obj.zOrder;
  const glyphObjects: SceneObject[] = [];
  let z = baseZ;
  const bakeFrames = collectIntegerFrames(obj.inPoint, obj.outPoint);

  for (const g of placements) {
    z += 0.001;
    if (mode === "keyframesOnChild") {
      glyphObjects.push(
        buildGlyphObjectBase(
          obj,
          g,
          z,
          style,
          props,
          obj.parent,
          bakeGlyphTransform(obj, g.x, g.y, bakeFrames, comp.fps, resolveCtx),
        ),
      );
    } else {
      glyphObjects.push(
        buildGlyphObjectBase(
          obj,
          g,
          z,
          style,
          props,
          obj.id,
          {
            anchor: staticProp({ x: 0, y: 0, z: 0 }),
            position: staticProp({ x: g.x, y: g.y, z: 0 }),
            rotation: staticProp({ x: 0, y: 0, z: 0 }),
            scale: staticProp({ x: 1, y: 1, z: 1 }),
          },
        ),
      );
    }
  }

  if (mode === "keyframesOnChild") {
    return [sourceLayer, ...glyphObjects];
  }

  const container: SceneObject = {
    ...obj,
    components: obj.components.map((c, i) =>
      i === textCompIdx
        ? {
            ...c,
            props: {
              ...c.props,
              text: staticProp(""),
            },
          }
        : c,
    ),
  };

  return [sourceLayer, container, ...glyphObjects];
}

/** 分解直前の SceneObject を複製して残す（編集・参照用。描画は glyph 側を正とする）。 */
function preserveDecomposeSourceLayer(obj: SceneObject): SceneObject {
  const clone = structuredClone(obj) as SceneObject;
  clone.id = newObjectId();
  clone.name = `${obj.name} (source)`;
  clone.parent = null;
  clone.zOrder = obj.zOrder - 0.01;
  clone.enabled = false;
  return clone;
}

/** Canvas 2D measureText ベースの計測コンテキスト（ブラウザ/editor 専用）。 */
export function createCanvasMeasureContext(
  font: string,
  size: number,
  weight: number,
  italic: boolean,
): GlyphMeasureContext {
  const canvas = document.createElement("canvas");
  const gctx = canvas.getContext("2d")!;
  const fontStyle = italic ? "italic" : "normal";
  gctx.font = `${fontStyle} ${weight} ${size}px ${font}`;
  return {
    measureChar: (char: string) => gctx.measureText(char).width,
  };
}

/** テスト用: 固定幅計測。 */
export function createFixedMeasureContext(widthPerChar: number): GlyphMeasureContext {
  return { measureChar: () => widthPerChar };
}
