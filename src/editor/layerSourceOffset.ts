import type { Component, Project, SceneObject } from "../core/schema";

/** §21.3 / §23: footage 系・comp レイヤーの源時刻オフセットを Δ frame ずらす（左端トリム・split 後半用）。 */
export function shiftFootageSourceOffset(
  components: Component[],
  deltaFrames: number,
): Component[] | null {
  if (deltaFrames === 0) return null;
  let changed = false;
  const next = components.map((c) => {
    if (c.type === "video" || c.type === "audio" || c.type === "comp") {
      const cur = typeof c.props.trimStart === "number" ? c.props.trimStart : 0;
      changed = true;
      return { ...c, props: { ...c.props, trimStart: Math.max(0, cur + deltaFrames) } };
    }
    if (c.type === "html") {
      const cur = typeof c.props.inPoint === "number" ? c.props.inPoint : 0;
      changed = true;
      return { ...c, props: { ...c.props, inPoint: Math.max(0, cur + deltaFrames) } };
    }
    return c;
  });
  return changed ? next : null;
}

export interface LayerSourceExtent {
  trimStart: number;
  sourceDuration: number;
}

/** タイムライン上のトリムゴースト表示用。solid/text 等は null。 */
export function getLayerSourceExtent(
  obj: SceneObject,
  project: Project,
  fps = 30,
): LayerSourceExtent | null {
  for (const c of obj.components) {
    if (c.type === "comp") {
      const compId = c.props["compId"];
      if (typeof compId !== "string") continue;
      const child = project.compositions.find((x) => x.id === compId && x.kind === "timeline");
      if (!child || child.kind !== "timeline") continue;
      return {
        trimStart: typeof c.props.trimStart === "number" ? c.props.trimStart : 0,
        sourceDuration: child.duration,
      };
    }
    if (c.type === "html") {
      const compId = c.props["compId"];
      if (typeof compId !== "string") continue;
      const html = project.compositions.find((x) => x.id === compId && x.kind === "html");
      if (!html) continue;
      return {
        trimStart: typeof c.props.inPoint === "number" ? c.props.inPoint : 0,
        sourceDuration: html.duration,
      };
    }
    if (c.type === "video" || c.type === "audio") {
      const assetId = c.props["asset"];
      if (typeof assetId !== "string") continue;
      const asset = project.assets.find((a) => a.id === assetId);
      const trimStart = typeof c.props.trimStart === "number" ? c.props.trimStart : 0;
      const dur = readAssetDurationFrames(asset?.meta, fps);
      return {
        trimStart,
        sourceDuration: dur ?? trimStart + Math.max(1, obj.outPoint - obj.inPoint),
      };
    }
  }
  return null;
}

function readAssetDurationFrames(meta: Record<string, unknown> | undefined, fps: number): number | null {
  if (!meta) return null;
  if (typeof meta.durationFrames === "number" && meta.durationFrames > 0) {
    return Math.floor(meta.durationFrames);
  }
  if (typeof meta.duration === "number" && meta.duration > 0) {
    return Math.max(1, Math.round(meta.duration * fps));
  }
  return null;
}
