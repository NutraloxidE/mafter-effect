import { newObjectId } from "../core/ids";
import { staticProp } from "../core/props";
import type { Frame, RGBA, SceneObject, TimelineComposition } from "../core/schema";
import { sampleAny } from "../runtime/interpolate";
import { layoutGlyphsForDecompose, type TextAlign } from "../runtime/textLayout";

export interface GlyphMeasureContext {
  measureChar: (char: string) => number;
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

/** §26.5 グリフ分解: 1 command で複数 SceneObject を生成する patch を作る。 */
export function buildGlyphDecomposeObjects(
  obj: SceneObject,
  _comp: TimelineComposition,
  frame: Frame,
  ctx: GlyphMeasureContext,
): SceneObject[] | null {
  const textCompIdx = obj.components.findIndex((c) => c.type === "text");
  if (textCompIdx < 0) return null;
  const textComp = obj.components[textCompIdx]!;
  const props = textComp.props;

  const sourceText = readAnimatedString(props, "text", frame, "");
  if (!sourceText) return null;

  const font = readStatic(props, "font", "sans-serif");
  const align = readStatic(props, "align", "left") as TextAlign;
  const weight = readStatic(props, "weight", 400);
  const italic = readStatic(props, "italic", false);
  const size = readAnimatedNumber(props, "size", frame, 48);
  const tracking = readAnimatedNumber(props, "tracking", frame, 0);
  const leading = readAnimatedNumber(props, "leading", frame, 0);
  const color = readAnimatedRgba(props, "color", frame, { r: 1, g: 1, b: 1, a: 1 });
  const strokeColor = readAnimatedRgba(props, "strokeColor", frame, { r: 0, g: 0, b: 0, a: 1 });
  const strokeWidth = readAnimatedNumber(props, "strokeWidth", frame, 0);

  const placements = layoutGlyphsForDecompose(sourceText, size, tracking, leading, align, ctx.measureChar);
  if (placements.length === 0) return null;

  const baseZ = obj.zOrder;
  const glyphObjects: SceneObject[] = [];
  let z = baseZ;

  for (const g of placements) {
    z += 0.001;
    const id = newObjectId();
    glyphObjects.push({
      id,
      name: `${obj.name} ${g.char}`,
      parent: obj.id,
      zOrder: z,
      enabled: true,
      inPoint: obj.inPoint,
      outPoint: obj.outPoint,
      transform: {
        anchor: staticProp({ x: 0, y: 0, z: 0 }),
        position: staticProp({ x: g.x, y: g.y, z: 0 }),
        rotation: staticProp({ x: 0, y: 0, z: 0 }),
        scale: staticProp({ x: 1, y: 1, z: 1 }),
      },
      opacity: { ...obj.opacity },
      components: [
        {
          type: "text",
          props: {
            text: staticProp(g.char),
            size: staticProp(size),
            color: staticProp(color),
            tracking: staticProp(0),
            leading: staticProp(0),
            strokeColor: staticProp(strokeColor),
            strokeWidth: staticProp(strokeWidth),
            font,
            align: "left",
            weight,
            italic,
          },
        },
      ],
    });
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

  return [container, ...glyphObjects];
}

/** Canvas 2D measureText ベースの計測コンテキスト（ブラウザ/editor 専用）。 */
export function createCanvasMeasureContext(
  font: string,
  size: number,
  weight: number,
  italic: boolean,
): GlyphMeasureContext {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const style = italic ? "italic" : "normal";
  ctx.font = `${style} ${weight} ${size}px ${font}`;
  return {
    measureChar: (char: string) => ctx.measureText(char).width,
  };
}

/** テスト用: 固定幅計測。 */
export function createFixedMeasureContext(widthPerChar: number): GlyphMeasureContext {
  return { measureChar: () => widthPerChar };
}
