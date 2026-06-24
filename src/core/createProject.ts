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

// optional フィールドの方針（1 本化）:
//   「値が存在するものは書く / 機能が不在のものはキーごと省略（null を書かない）」（§5.6-canon）。
//   - background: comp の塗り（authored な値）なので明示する。
//   この規則は createProject の populate と canonicalStringify の undefined 省略で一貫する。
//   （active camera は永続しない。frame ごとに最前面の可視カメラを resolve() が選ぶ・§6.5）
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
    // 背景は未設定 = 透明（§5.6）。
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
