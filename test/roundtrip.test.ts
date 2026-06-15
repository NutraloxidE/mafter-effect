import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { loadProject, saveProject } from "../src/core/projectFs";
import { serializeProject } from "../src/core/serialize";
import { MemoryFs } from "../src/fs/MemoryFs";
import { IndexedDbFs } from "../src/fs/IndexedDbFs";
import { exportZip, importZip } from "../src/fs/zip";
import type { FileSystem } from "../src/fs/FileSystem";

// M0 受け入れ条件:
// 作成 → 保存 → 再読込 → zip DL → 再 import で project.json が正準シリアライズ後 byte 等価 (INV-4)。
async function runRoundtrip(fs: FileSystem) {
  const project = createProject({ now: "2026-01-01T00:00:00.000Z" });
  const canonical = serializeProject(project);

  // save
  await saveProject(fs, project);

  // reload
  const { project: reloaded } = await loadProject(fs);
  expect(serializeProject(reloaded)).toBe(canonical);

  // zip export → import into a fresh FS
  const zipBytes = await exportZip(fs);
  const fs2 = new MemoryFs();
  await importZip(fs2, zipBytes);

  const { project: reimported } = await loadProject(fs2);
  expect(serializeProject(reimported)).toBe(canonical);

  // project.json bytes themselves are identical across FSs
  const a = await fs.readText("project.json");
  const b = await fs2.readText("project.json");
  expect(a).toBe(b);
  expect(a).toBe(canonical);
}

describe("M0 roundtrip — INV-4 byte equivalence", () => {
  it("MemoryFs: create → save → reload → zip → reimport is byte-equal", async () => {
    await runRoundtrip(new MemoryFs());
  });

  it("IndexedDbFs: create → save → reload → zip → reimport is byte-equal", async () => {
    await runRoundtrip(new IndexedDbFs(`test-db-${Date.now()}`));
  });

  it("IndexedDbFs and MemoryFs produce identical FS layout (INV-4)", async () => {
    const project = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const mem = new MemoryFs();
    const idb = new IndexedDbFs(`test-db-layout-${Date.now()}`);
    await saveProject(mem, project);
    await saveProject(idb, project);
    expect(await mem.list("")).toEqual(await idb.list(""));
  });

  it("zip export is deterministic (same project → same bytes)", async () => {
    const project = createProject({ now: "2026-01-01T00:00:00.000Z" });
    const fs1 = new MemoryFs();
    const fs2 = new MemoryFs();
    await saveProject(fs1, project);
    await saveProject(fs2, project);
    const z1 = await exportZip(fs1);
    const z2 = await exportZip(fs2);
    expect(Array.from(z1)).toEqual(Array.from(z2));
  });
});
