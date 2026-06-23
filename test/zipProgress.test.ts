import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { saveProject } from "../src/core/projectFs";
import { MemoryFs } from "../src/fs/MemoryFs";
import { exportZip, type ZipExportProgress } from "../src/fs/zip";

describe("exportZip progress", () => {
  it("reports list → read → pack phases in order", async () => {
    const fs = new MemoryFs();
    const project = createProject({ now: "2026-01-01T00:00:00.000Z" });
    await saveProject(fs, project);
    await fs.write("assets/demo.txt", "hello");

    const events: ZipExportProgress[] = [];
    await exportZip(fs, "", (p) => events.push({ ...p }));

    const phases = events.map((e) => e.phase);
    expect(phases[0]).toBe("list");
    expect(phases.filter((p) => p === "read").length).toBe(2);
    expect(phases.some((p) => p === "pack")).toBe(true);
    expect(phases.indexOf("list")).toBeLessThan(phases.indexOf("read"));
    expect(phases.lastIndexOf("read")).toBeLessThan(phases.indexOf("pack"));

    const listEvt = events.find((e) => e.phase === "list");
    expect(listEvt?.total).toBe(2);

    const readEvts = events.filter((e) => e.phase === "read");
    expect(readEvts.map((e) => e.current)).toEqual([1, 2]);

    const packEvts = events.filter((e) => e.phase === "pack");
    expect(packEvts.length).toBeGreaterThan(0);
    expect(packEvts[packEvts.length - 1]!.current).toBe(100);
  });

  it("works without onProgress (backward compatible)", async () => {
    const fs = new MemoryFs();
    await saveProject(fs, createProject({ now: "2026-01-01T00:00:00.000Z" }));
    const bytes = await exportZip(fs);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
