import { newCompId } from "./ids";
import type { Project, TimelineComposition } from "./schema";
import { CURRENT_SCHEMA_VERSION } from "./schema";

export interface NewProjectOptions {
  name?: string;
  width?: number;
  height?: number;
  fps?: number;
  durationSeconds?: number;
  now?: string; // ISO 文字列。テストの決定論のため注入可能（INV-1 ではないが byte 等価のため）。
}

/** 既定の timeline comp を 1 つ持つ空プロジェクトを生成する。 */
export function createProject(opts: NewProjectOptions = {}): Project {
  const {
    name = "Untitled",
    width = 1920,
    height = 1080,
    fps = 30,
    durationSeconds = 5,
    now = new Date().toISOString(),
  } = opts;

  const compId = newCompId();
  const mainComp: TimelineComposition = {
    id: compId,
    name: "Main",
    kind: "timeline",
    width,
    height,
    fps,
    duration: Math.round(durationSeconds * fps),
    background: { r: 0, g: 0, b: 0, a: 1 },
    objects: [],
  };

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta: { name, createdAt: now, updatedAt: now },
    assets: [],
    compositions: [mainComp],
    rootComposition: compId,
    pluginRefs: [],
  };
}
