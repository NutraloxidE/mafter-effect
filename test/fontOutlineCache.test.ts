import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import { FontOutlineCache } from "../src/runtime/fontOutlineCache";
import type { Project } from "../src/core/schema";
import type { FileSystem } from "../src/fs/FileSystem";

// §26.4.1 3D 押し出しのアウトラインは family だけでなく weight で引けなければならない
// （family 単独キーだと最初に埋め込んだ weight が居座り、weight 変更が 3D に反映されない）。
const FONT_DIR = resolvePath(__dirname, "../public/fonts");

const REGULAR = "assets/fonts/regular.ttf";
const BOLD = "assets/fonts/bold.ttf";

const FILE_BY_PATH: Record<string, string> = {
  [REGULAR]: "NotoSans-Regular.ttf",
  [BOLD]: "NotoSans-Bold.ttf",
};

const fakeFs = {
  read: async (path: string) => {
    const file = FILE_BY_PATH[path];
    if (!file) throw new Error(`no such file: ${path}`);
    return new Uint8Array(await readFile(resolvePath(FONT_DIR, file)));
  },
} as unknown as FileSystem;

function fontProject(assets: { id: string; path: string; family: string; weight?: number }[]): Project {
  return {
    assets: assets.map((a) => ({
      id: a.id,
      path: a.path,
      kind: "font" as const,
      meta: a.weight === undefined ? { family: a.family } : { family: a.family, weight: a.weight },
    })),
  } as unknown as Project;
}

async function loadRegularAndBold(): Promise<FontOutlineCache> {
  const cache = new FontOutlineCache();
  await cache.loadFromProject(
    fontProject([
      { id: "r", path: REGULAR, family: "Noto Sans", weight: 400 },
      { id: "b", path: BOLD, family: "Noto Sans", weight: 700 },
    ]),
    fakeFs,
  );
  return cache;
}

/** 同じ字を描いたときのアウトライン太さの代理指標（Bold のほうが advance が広い）。 */
function advanceOf(cache: FontOutlineCache, weight: number): number {
  const font = cache.getFont("Noto Sans", weight);
  expect(font).not.toBeNull();
  return font!.charToGlyph("A").advanceWidth ?? 0;
}

describe("FontOutlineCache family×weight", () => {
  it("同 family の Regular と Bold を別アウトラインとして保持する", async () => {
    const cache = await loadRegularAndBold();
    const regular = cache.getFont("Noto Sans", 400);
    const bold = cache.getFont("Noto Sans", 700);
    expect(regular).not.toBeNull();
    expect(bold).not.toBeNull();
    expect(bold).not.toBe(regular);
    // Bold は実際に太い = 3D 押し出しが選択 weight のアウトラインを見ている証拠
    expect(advanceOf(cache, 700)).toBeGreaterThan(advanceOf(cache, 400));
  });

  it("完全一致が無ければ最近傍 weight にフォールバックする", async () => {
    const cache = await loadRegularAndBold();
    expect(cache.getFont("Noto Sans", 600)).toBe(cache.getFont("Noto Sans", 700));
    expect(cache.getFont("Noto Sans", 450)).toBe(cache.getFont("Noto Sans", 400));
  });

  it("font スタックの先頭 family で引ける", async () => {
    const cache = await loadRegularAndBold();
    expect(cache.getFont("'Noto Sans', sans-serif", 700)).toBe(cache.getFont("Noto Sans", 700));
  });

  it("未登録 family は null", async () => {
    const cache = await loadRegularAndBold();
    expect(cache.getFont("Nonexistent", 400)).toBeNull();
  });

  it("meta.weight 未設定の旧 asset は 400 として扱い、weight 指定でも唯一の face を返す", async () => {
    const cache = new FontOutlineCache();
    await cache.loadFromProject(
      fontProject([{ id: "r", path: REGULAR, family: "Noto Sans" }]),
      fakeFs,
    );
    const legacy = cache.getFont("Noto Sans", 400);
    expect(legacy).not.toBeNull();
    expect(cache.getFont("Noto Sans", 700)).toBe(legacy);
  });
});
