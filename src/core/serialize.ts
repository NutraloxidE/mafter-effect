import type { Project, TimelineComposition } from "./schema";

// §5.6 正準シリアライズ:
//   - キー順固定（再帰的にキーをアルファベット昇順へ正規化 → 決定論的・安定）
//   - objects は id 昇順（§5.4-note: 配列順に意味を持たせない）
//   - id を持つ配列（compositions / assets / pluginRefs）も id 昇順で安定化
//   - 2-space indent + 末尾改行
//   これにより INV-4（byte 等価）と Git diff の安定性を保証する。

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byStringKey<T extends { id: string }>(a: T, b: T): number {
  return byId(a, b);
}

/**
 * 直列化前にプロジェクトを正準形へ正規化する（深いコピーを返す。入力は変更しない）。
 * 配列順を id 昇順に固定し、追加/削除/並べ替えのどれでも diff が局所化されるようにする。
 */
export function canonicalizeProject(project: Project): Project {
  const compositions = project.compositions
    .map((comp) => {
      if (comp.kind === "timeline") {
        const t: TimelineComposition = {
          ...comp,
          objects: [...comp.objects].sort(byId),
        };
        return t;
      }
      return { ...comp };
    })
    .sort(byStringKey);

  return {
    ...project,
    assets: [...project.assets].sort(byId),
    compositions,
    pluginRefs: [...project.pluginRefs].sort(byStringKey),
  };
}

/**
 * 決定論的 JSON 文字列化。
 * - オブジェクトのキーを再帰的にアルファベット昇順へ並べる（キー順固定）。
 * - undefined のプロパティは省略（JSON.stringify と同挙動）。
 * - 配列順は保持する（呼び出し前に canonicalizeProject で安定化済み）。
 */
export function canonicalStringify(value: unknown, indent = 2): string {
  return stringifyValue(value, indent, 0) + "\n";
}

function stringifyValue(value: unknown, indent: number, depth: number): string {
  if (value === null) return "null";

  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error(`canonicalStringify: non-finite number (${String(value)})`);
    }
    return JSON.stringify(value);
  }
  if (t === "string" || t === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const pad = " ".repeat(indent * (depth + 1));
    const closePad = " ".repeat(indent * depth);
    const items = value.map(
      (v) => pad + stringifyValue(v, indent, depth + 1),
    );
    return "[\n" + items.join(",\n") + "\n" + closePad + "]";
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    if (keys.length === 0) return "{}";
    const pad = " ".repeat(indent * (depth + 1));
    const closePad = " ".repeat(indent * depth);
    const entries = keys.map(
      (k) =>
        pad +
        JSON.stringify(k) +
        ": " +
        stringifyValue(obj[k], indent, depth + 1),
    );
    return "{\n" + entries.join(",\n") + "\n" + closePad + "}";
  }

  throw new Error(`canonicalStringify: unsupported value type "${t}"`);
}

/** project.json の正準テキストを返す。 */
export function serializeProject(project: Project): string {
  return canonicalStringify(canonicalizeProject(project));
}

/** project.json テキストをパースする。検証は validateProject（別途）で行う。 */
export function deserializeProject(text: string): Project {
  return JSON.parse(text) as Project;
}
