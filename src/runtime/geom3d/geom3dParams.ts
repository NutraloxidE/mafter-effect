import type { ParamDescriptor, Vec3 } from "../../core/schema";
import type { BevelStyle, Geom3DParams } from "./geom3dTypes";

/**
 * §5.5f — text（将来 shape も同じ配列を concat する・§9.14 P4）に追加する 3D 押し出しパラメータ。
 * flat prop なので既存 Timeline KF 行・Inspector PropRow・undo 配線をそのまま使える（§26.2 と同じ契約）。
 * 本セッションのスコープ = depth/bevel/shading のみ（twist/bend/taper/gradient は次フェーズ）。
 */
export const GEOM3D_PARAM_DESCRIPTORS: ParamDescriptor[] = [
  { key: "geomEnabled", label: "3D Extrude", kind: "bool", default: false, animatable: false },
  { key: "geomDepth", label: "Depth", kind: "scalar", default: 50, animatable: true, min: 0 },
  { key: "geomBevelSize", label: "Bevel Size", kind: "scalar", default: 0, animatable: true, min: 0 },
  { key: "geomBevelStyle", label: "Bevel Style", kind: "enum", default: "angular", animatable: false, options: ["angular", "round", "concave"] },
  { key: "geomBevelSegments", label: "Bevel Segments", kind: "scalar", default: 2, animatable: false, min: 1, max: 8, step: 1 },
  { key: "geomCurveQuality", label: "Curve Quality", kind: "enum", default: "medium", animatable: false, options: ["low", "medium", "high"] },
  { key: "geomShading", label: "Shading", kind: "enum", default: "lambert", animatable: false, options: ["none", "lambert"] },
  { key: "geomAmbient", label: "Ambient", kind: "scalar", default: 0.35, animatable: true, min: 0, max: 1 },
  { key: "geomLightDir", label: "Light Dir", kind: "vec3", default: { x: -0.5, y: -0.7, z: -0.5 }, animatable: false },
];

const DEFAULT_LIGHT_DIR: Vec3 = { x: -0.5, y: -0.7, z: -0.5 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function isVec3(v: unknown): v is Vec3 {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Vec3).x === "number" &&
    typeof (v as Vec3).y === "number" &&
    typeof (v as Vec3).z === "number"
  );
}

/** ResolvedScene の props（resolve 済み値）を防御的に読む。§26.4 の parseTextProps と同型。 */
export function parseGeom3DParams(props: Record<string, unknown>): Geom3DParams {
  const bevelSegmentsRaw = typeof props["geomBevelSegments"] === "number" ? props["geomBevelSegments"] : 2;
  const bevelStyleRaw = props["geomBevelStyle"];
  const curveQualityRaw = props["geomCurveQuality"];
  const shadingRaw = props["geomShading"];
  return {
    enabled: props["geomEnabled"] === true,
    depth: typeof props["geomDepth"] === "number" ? Math.max(0, props["geomDepth"]) : 50,
    bevelSize: typeof props["geomBevelSize"] === "number" ? Math.max(0, props["geomBevelSize"]) : 0,
    bevelStyle: bevelStyleRaw === "round" || bevelStyleRaw === "concave" ? (bevelStyleRaw as BevelStyle) : "angular",
    bevelSegments: Math.round(clamp(bevelSegmentsRaw, 1, 8)),
    curveQuality: curveQualityRaw === "low" || curveQualityRaw === "high" ? curveQualityRaw : "medium",
    shading: shadingRaw === "none" ? "none" : "lambert",
    lightDir: isVec3(props["geomLightDir"]) ? props["geomLightDir"] : DEFAULT_LIGHT_DIR,
    ambient: typeof props["geomAmbient"] === "number" ? clamp(props["geomAmbient"], 0, 1) : 0.35,
  };
}

/** curveQuality → ベジェ 1 辺あたりの分割数（outlineProvider が使う）。 */
export function curveQualitySegments(q: Geom3DParams["curveQuality"]): number {
  if (q === "low") return 8;
  if (q === "high") return 32;
  return 16;
}
