import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { unreferencedAssetFilePaths } from "../src/editor/assetFileRefs";

describe("unreferencedAssetFilePaths", () => {
  it("keeps original and proxy files while a duplicated asset entry shares them", () => {
    const project = createProject();
    const meta = {
      originalPath: "assets/original.mov",
      proxies: { medium: { path: "assets/proxy.webm" } },
    };
    project.assets = [
      { id: "a", kind: "video", path: "assets/source.webm", meta },
      { id: "b", kind: "video", path: "assets/source.webm", meta: structuredClone(meta) },
    ];
    expect(unreferencedAssetFilePaths(project, "a")).toEqual([]);
  });

  it("returns all owned files when no other asset references them", () => {
    const project = createProject();
    project.assets = [{
      id: "a",
      kind: "video",
      path: "assets/source.webm",
      meta: {
        originalPath: "assets/original.mov",
        proxies: { medium: { path: "assets/proxy.webm" } },
      },
    }];
    expect(new Set(unreferencedAssetFilePaths(project, "a"))).toEqual(new Set([
      "assets/source.webm",
      "assets/original.mov",
      "assets/proxy.webm",
    ]));
  });
});
