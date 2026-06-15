import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { defaultTransform, staticProp, vec3 } from "../src/core/props";
import { loadProject, saveProject } from "../src/core/projectFs";
import { canonicalStringify, serializeProject } from "../src/core/serialize";
import type { Project, SceneObject, TimelineComposition } from "../src/core/schema";
import { MemoryFs } from "../src/fs/MemoryFs";
import { IndexedDbFs } from "../src/fs/IndexedDbFs";
import { exportZip, importZip } from "../src/fs/zip";

// 日本語名は明示コードポイントで構築し、ソースファイルのエンコーディング/正規化に依存させない。
const COMP_NAME = "メインコンポ"; // メインコンポ
const OBJ_NAME = "背景レイヤー"; // 背景レイヤー
const PROJ_NAME = "メインプロジェクト"; // メインプロジェクト

function timeline(p: Project): TimelineComposition {
  const comp = p.compositions[0];
  if (!comp || comp.kind !== "timeline") throw new Error("expected timeline");
  return comp;
}

function jpObject(): SceneObject {
  const t = defaultTransform();
  // float をわざと混ぜる（authored 値）。
  t.position = staticProp(vec3(123.5, -0.25, 0));
  return {
    id: "01OBJ",
    name: OBJ_NAME,
    parent: null,
    zOrder: 1.5, // fractional
    enabled: true,
    inPoint: 0,
    outPoint: 150,
    transform: t,
    opacity: staticProp(0.5),
    components: [{ type: "solid", props: { color: { r: 1, g: 0, b: 0, a: 1 } } }],
  };
}

function jpProject(): Project {
  const p = createProject({ name: PROJ_NAME, now: "2026-01-01T00:00:00.000Z" });
  const comp = timeline(p);
  comp.name = COMP_NAME;
  comp.objects = [jpObject()];
  return p;
}

describe("Japanese / UTF-8 round-trip (gotcha #2: raw NFC, not \\uXXXX)", () => {
  it("emits raw Japanese, not unicode escapes", () => {
    const text = serializeProject(jpProject());
    expect(text).toContain(COMP_NAME);
    expect(text).toContain(OBJ_NAME);
    expect(text).not.toMatch(/\\u[0-9a-fA-F]{4}/);
  });

  it("MemoryFs: save → reload is byte-equal with Japanese names", async () => {
    const fs = new MemoryFs();
    const p = jpProject();
    const canonical = serializeProject(p);
    await saveProject(fs, p);
    const { project: reloaded } = await loadProject(fs);
    expect(serializeProject(reloaded)).toBe(canonical);
  });

  it("IndexedDbFs: save → reload is byte-equal with Japanese names", async () => {
    const fs = new IndexedDbFs(`test-jp-${Date.now()}`);
    const p = jpProject();
    const canonical = serializeProject(p);
    await saveProject(fs, p);
    const { project: reloaded } = await loadProject(fs);
    expect(serializeProject(reloaded)).toBe(canonical);
  });
});

describe("NFC normalization (§5.6-canon)", () => {
  it("decomposed and composed inputs serialize to identical bytes", () => {
    // U+30AC (ガ, composed) vs U+30AB U+3099 (カ + combining dakuten, decomposed)
    const composed = String.fromCodePoint(0x30ac);
    const decomposed = String.fromCodePoint(0x30ab, 0x3099);
    expect(composed).not.toBe(decomposed); // 入力は別バイト列

    // 同一の base を clone（createProject は呼ぶたびに新 ULID を振るため）。
    const base = jpProject();
    const a: Project = structuredClone(base);
    const b: Project = structuredClone(base);
    timeline(a).name = composed;
    timeline(b).name = decomposed;
    const sa = serializeProject(a);
    expect(sa).toBe(serializeProject(b));
    expect(sa).toContain(composed); // 出力は NFC composed 形
  });
});

describe("float round-trip (ES shortest representation)", () => {
  it("uses ECMAScript number formatting (no trailing zeros / no exponent)", () => {
    const text = serializeProject(jpProject());
    expect(text).toContain("123.5");
    expect(text).toContain("-0.25");
    expect(text).toContain("1.5"); // zOrder
    expect(text).not.toContain("123.50");
  });

  it("normalizes -0 to 0 (isolated)", () => {
    expect(canonicalStringify({ x: -0 })).toBe('{\n  "x": 0\n}\n');
    expect(canonicalStringify(vec3(-0, -0, 0))).not.toContain("-0");
  });

  it("MemoryFs: float values survive save → reload byte-equal", async () => {
    const fs = new MemoryFs();
    const p = jpProject();
    const canonical = serializeProject(p);
    await saveProject(fs, p);
    const { project: reloaded } = await loadProject(fs);
    expect(serializeProject(reloaded)).toBe(canonical);
  });
});

describe("zip round-trip (Export → Import → byte-equal, M0 acceptance)", () => {
  it("Japanese-named project survives zip export → import unchanged", async () => {
    const fs1 = new MemoryFs();
    const p = jpProject();
    const canonical = serializeProject(p);
    await saveProject(fs1, p);

    const zipBytes = await exportZip(fs1);
    const fs2 = new MemoryFs();
    await importZip(fs2, zipBytes);

    const { project: reimported } = await loadProject(fs2);
    expect(serializeProject(reimported)).toBe(canonical);
    expect(await fs2.readText("project.json")).toBe(canonical);
  });
});
