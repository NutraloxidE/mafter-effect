import { describe, expect, it, vi } from "vitest";
import {
  buildCommandTree,
  nodeAtPath,
  pathLabels,
  resolveLevel,
} from "../src/editor/commandMenu/commandTree";
import { isSecondTap } from "../src/editor/commandMenu/leaderTap";
import type { CommandLeaf } from "../src/editor/commandMenu/types";

function leaf(id: string, path: [string, string][], run = () => {}): CommandLeaf {
  return { id, path: path.map(([key, label]) => ({ key, label })), run };
}

describe("buildCommandTree", () => {
  it("folds leaves that share a prefix into one group", () => {
    const tree = buildCommandTree([
      leaf("a", [["m", "マクロ"], ["t", "テキスト一括置換"]]),
      leaf("b", [["m", "マクロ"], ["r", "リネーム"]]),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.key).toBe("m");
    expect(tree[0]!.label).toBe("マクロ");
    expect(tree[0]!.children.map((c) => c.key)).toEqual(["t", "r"]);
  });

  it("leaf nodes carry run; group nodes do not", () => {
    const spy = vi.fn();
    const tree = buildCommandTree([leaf("a", [["m", "マクロ"], ["t", "T"]], spy)]);
    const group = tree[0]!;
    expect(group.run).toBeUndefined();
    group.children[0]!.run!();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("keeps registration order and normalizes keys to lowercase", () => {
    const tree = buildCommandTree([
      leaf("a", [["M", "マクロ"], ["T", "テキスト"]]),
      leaf("b", [["f", "ファイル"]]),
    ]);
    expect(tree.map((n) => n.key)).toEqual(["m", "f"]);
    expect(tree[0]!.children[0]!.key).toBe("t");
  });

  it("later leaf with same full path overrides run", () => {
    const first = vi.fn();
    const second = vi.fn();
    const tree = buildCommandTree([
      leaf("a", [["m", "マクロ"], ["t", "T"]], first),
      leaf("a2", [["m", "マクロ"], ["t", "T"]], second),
    ]);
    tree[0]!.children[0]!.run!();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("ignores empty-path leaves", () => {
    const tree = buildCommandTree([{ id: "x", path: [], run: () => {} }]);
    expect(tree).toEqual([]);
  });
});

describe("resolveLevel / nodeAtPath / pathLabels", () => {
  const tree = buildCommandTree([
    leaf("a", [["m", "マクロ"], ["t", "テキスト一括置換"]]),
    leaf("b", [["m", "マクロ"], ["r", "リネーム"]]),
  ]);

  it("resolveLevel returns children at a path (case-insensitive)", () => {
    expect(resolveLevel(tree, [])!.map((n) => n.key)).toEqual(["m"]);
    expect(resolveLevel(tree, ["M"])!.map((n) => n.key)).toEqual(["t", "r"]);
    expect(resolveLevel(tree, ["m", "t"])).toEqual([]); // 葉の子は空
    expect(resolveLevel(tree, ["z"])).toBeNull();
  });

  it("nodeAtPath returns the node itself", () => {
    expect(nodeAtPath(tree, ["m", "t"])!.label).toBe("テキスト一括置換");
    expect(nodeAtPath(tree, ["m", "z"])).toBeNull();
  });

  it("pathLabels returns breadcrumb labels", () => {
    expect(pathLabels(tree, ["m", "t"])).toEqual(["マクロ", "テキスト一括置換"]);
    expect(pathLabels(tree, ["m", "zzz"])).toEqual(["マクロ"]);
  });
});

describe("isSecondTap (double-tap window)", () => {
  it("no prior tap (0) is never a double tap", () => {
    expect(isSecondTap(0, 1000)).toBe(false);
  });
  it("within the window counts as second tap", () => {
    expect(isSecondTap(1000, 1300, 400)).toBe(true);
    expect(isSecondTap(1000, 1400, 400)).toBe(true);
  });
  it("outside the window does not", () => {
    expect(isSecondTap(1000, 1401, 400)).toBe(false);
  });
});
