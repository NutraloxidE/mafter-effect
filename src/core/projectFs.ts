import type { FileSystem } from "../fs/FileSystem";
import { PROJECT_JSON } from "./paths";
import type { Project } from "./schema";
import { deserializeProject, serializeProject } from "./serialize";
import { validateProject, type ValidationResult } from "./validate";

/**
 * project.json を正準シリアライズして FS に書き込む。
 *
 * updatedAt の方針（minimal diff のため確定）: save では **自動 bump しない**。
 * `meta.updatedAt` は「実際に内容が変わった編集」でのみ更新する（M1 の command 層で実施）。
 * no-op save で 1 行 diff が出るのを避けるため、この関数は project を一切変更しない。
 */
export async function saveProject(
  fs: FileSystem,
  project: Project,
): Promise<void> {
  const text = serializeProject(project);
  await fs.write(PROJECT_JSON, text);
}

/** FS から project.json を読み、検証・マイグレーションして返す。 */
export async function loadProject(fs: FileSystem): Promise<ValidationResult> {
  if (!(await fs.exists(PROJECT_JSON))) {
    throw new Error(`projectFs: ${PROJECT_JSON} not found`);
  }
  // Phase 4: readText（bytesToText 経由の中間 string）を挟まず、bytes を直接 deserializeProject へ。
  const bytes = await fs.read(PROJECT_JSON);
  const raw = deserializeProject(bytes);
  return validateProject(raw);
}
