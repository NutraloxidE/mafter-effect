import type { Project, SceneObject, TimelineComposition } from "./schema";

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
 * §27.4 / §5.4b / §5.6-canon: 既定値のフィールドは省略して既存 project.json と byte 等価を保つ。
 * - adjustmentMode は `"raster"` のときだけ書く（live 既定・非調整レイヤーでは省略）。
 * - threeD は true のときだけ書く（false/省略は平面 2D）。
 * - threeDMode は dom/raster3d のときだけ書く（"auto" 既定は省略）。
 */
function canonicalizeObject(obj: SceneObject): SceneObject {
  let out = obj;
  const strip = (patch: Partial<SceneObject>) => {
    out = { ...out, ...patch };
  };
  if (!(obj.isAdjustment === true && obj.adjustmentMode === "raster") && obj.adjustmentMode !== undefined) {
    strip({ adjustmentMode: undefined });
  }
  if (obj.threeD !== true && obj.threeD !== undefined) strip({ threeD: undefined });
  if (obj.threeDMode === "auto") strip({ threeDMode: undefined });
  if (obj.labelIndex !== undefined && (obj.labelIndex < 0 || obj.labelIndex > 16)) {
    strip({ labelIndex: undefined });
  }
  // §5.4d: blendMode は "normal" 以外のときだけ書く（既定 normal・省略は byte 等価維持）。
  if (obj.blendMode === "normal") strip({ blendMode: undefined });
  return out;
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
          objects: [...comp.objects].sort(byId).map(canonicalizeObject),
        };
        // §5.4b: renderer3d は "advanced" のときだけ書く（"classic" 既定は省略）。
        if (t.renderer3d === "classic") t.renderer3d = undefined;
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

// §5.6-canon: 文字列は Unicode NFC へ正規化し、UTF-8 のまま出力する（JSON.stringify は
// 非 ASCII を \uXXXX にせず生で出すため、normalize → JSON.stringify で日本語名も生のまま残る）。
function emitString(s: string): string {
  return JSON.stringify(s.normalize("NFC"));
}

/**
 * 決定論的 JSON 文字列化（§5.6-canon の byte 直列化, RFC 8785 / JCS 基礎）。
 * - オブジェクトのキーを NFC 正規化後に UTF-16 code unit 順で再帰ソート（キー順固定）。
 * - 文字列値は NFC 正規化（生 UTF-8、\uXXXX にしない）。
 * - 数値は ECMAScript 最短往復表現（JSON.stringify 準拠）。NaN/Infinity は不正。
 * - undefined のプロパティは省略（null を書かない）。空配列/オブジェクトは [] / {}。
 * - 配列順は保持する（呼び出し前に canonicalizeProject で集合配列を id 昇順に安定化済み）。
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
  if (t === "string") {
    return emitString(value as string);
  }
  if (t === "boolean") {
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
    // キーを NFC 正規化してから UTF-16 code unit 順でソート（正規化後に並べないと一意性が崩れる）。
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .map((k) => ({ raw: k, norm: k.normalize("NFC") }))
      .sort((a, b) => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0));
    if (keys.length === 0) return "{}";
    const pad = " ".repeat(indent * (depth + 1));
    const closePad = " ".repeat(indent * depth);
    const entries = keys.map(
      ({ raw, norm }) =>
        pad +
        emitString(norm) +
        ": " +
        stringifyValue(obj[raw], indent, depth + 1),
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
