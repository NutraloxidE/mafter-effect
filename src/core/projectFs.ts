import type { FileSystem } from "../fs/FileSystem";
import { PROJECT_JSON } from "./paths";
import type { Project } from "./schema";
import { deserializeProject, serializeProject } from "./serialize";
import { validateProject, type ValidationResult } from "./validate";

/**
 * project.json を正準シリアライズして FS に書き込む。
 * 書き込み前に updatedAt を更新する場合は呼び出し側で行う（決定論テストのため here では触らない）。
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
  const text = await fs.readText(PROJECT_JSON);
  const raw = deserializeProject(text);
  return validateProject(raw);
}
