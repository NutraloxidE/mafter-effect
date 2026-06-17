import { ulid } from "ulid";
import { DIR_PRESETS_EASING } from "../core/paths";
import type { FileSystem } from "../fs/FileSystem";

/** §10 / §24: presets/easing/<id>.json の on-disk 形式。 */
export interface EasingPresetFile {
  id: string;
  label: string;
  bezier: [number, number, number, number];
}

export function easingPresetPath(id: string): string {
  return `${DIR_PRESETS_EASING}/${id}.json`;
}

export async function listUserEasingPresets(fs: FileSystem): Promise<EasingPresetFile[]> {
  try {
    const paths = await fs.list(DIR_PRESETS_EASING);
    const out: EasingPresetFile[] = [];
    for (const p of paths) {
      if (!p.endsWith(".json")) continue;
      try {
        const raw = await fs.readText(p);
        const parsed = JSON.parse(raw) as EasingPresetFile;
        if (
          typeof parsed.id === "string" &&
          typeof parsed.label === "string" &&
          Array.isArray(parsed.bezier) &&
          parsed.bezier.length === 4
        ) {
          out.push({
            id: parsed.id,
            label: parsed.label,
            bezier: parsed.bezier as [number, number, number, number],
          });
        }
      } catch {
        // 壊れたプリセットはスキップ
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  } catch {
    return [];
  }
}

export async function deleteUserEasingPreset(fs: FileSystem, id: string): Promise<boolean> {
  const path = easingPresetPath(id);
  if (!(await fs.exists(path))) return false;
  await fs.delete(path);
  return true;
}

export async function saveUserEasingPreset(
  fs: FileSystem,
  label: string,
  bezier: [number, number, number, number],
): Promise<EasingPresetFile> {
  await fs.mkdir(DIR_PRESETS_EASING);
  const preset: EasingPresetFile = {
    id: ulid(),
    label: label.trim() || `Preset ${Date.now()}`,
    bezier,
  };
  const body = `${JSON.stringify(preset, null, 2)}\n`;
  await fs.write(easingPresetPath(preset.id), body);
  return preset;
}
