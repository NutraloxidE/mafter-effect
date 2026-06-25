import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { newBinId } from "../src/core/ids";
import { createBinInProject } from "../src/core/projectTree";
import {
  canMoveBinTo,
  entryKey,
  parseEntryKey,
  parseTreeDragPayload,
  serializeTreeDragPayload,
} from "../src/editor/panels/projectTree/projectTreeSelection";

describe("projectTreeSelection", () => {
  it("entryKey round-trips", () => {
    const entry = { kind: "asset" as const, id: "01ABC" };
    expect(parseEntryKey(entryKey(entry))).toEqual(entry);
  });

  it("serializeTreeDragPayload supports multi-entry", () => {
    const entries = [
      { kind: "composition" as const, id: "01A" },
      { kind: "asset" as const, id: "01B" },
    ];
    expect(parseTreeDragPayload(serializeTreeDragPayload(entries))).toEqual(entries);
  });

  it("canMoveBinTo blocks moving into descendant folder", () => {
    const parent = newBinId();
    const child = newBinId();
    let p = createBinInProject(createProject(), parent, "Parent", null);
    p = createBinInProject(p, child, "Child", parent);
    expect(canMoveBinTo(p, parent, child)).toBe(false);
    expect(canMoveBinTo(p, parent, null)).toBe(true);
    expect(canMoveBinTo(p, child, parent)).toBe(true);
  });
});
