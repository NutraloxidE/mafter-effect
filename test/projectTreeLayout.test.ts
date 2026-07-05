import { describe, expect, it } from "vitest";
import { PROJECT_TREE_ROW_PAD_RIGHT, projectTreeRowPadLeft } from "../src/editor/panels/projectTree/projectTreeLayout";

describe("projectTreeRowPadLeft", () => {
  it("increases left padding with nesting depth", () => {
    expect(projectTreeRowPadLeft(0)).toBe(10);
    expect(projectTreeRowPadLeft(1)).toBe(24);
    expect(projectTreeRowPadLeft(2)).toBe(38);
    expect(projectTreeRowPadLeft(2)).toBeGreaterThan(projectTreeRowPadLeft(0));
  });

  it("keeps right padding fixed regardless of depth", () => {
    expect(PROJECT_TREE_ROW_PAD_RIGHT).toBe(6);
  });
});
