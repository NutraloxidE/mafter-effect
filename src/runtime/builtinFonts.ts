// §26.3.2 ビルトイン同梱フォント。実フォントファイルを同梱し、環境非依存で
// preview と export を一致させる（INV-2）。登録の単一情報源はこのファイル。

export interface BuiltinFontWeight {
  weight: number;
  /** public/fonts/ 配下のファイル名。 */
  file: string;
}

export interface BuiltinFontDef {
  /** CSS font-family 名。`font` プロパティのスタック先頭に置く。 */
  family: string;
  /** Inspector ドロップダウンの表示名。 */
  label: string;
  weights: BuiltinFontWeight[];
}

export const BUILTIN_FONTS: BuiltinFontDef[] = [
  {
    family: "Noto Sans",
    label: "Noto Sans",
    weights: [
      { weight: 400, file: "NotoSans-Regular.ttf" },
      { weight: 500, file: "NotoSans-Medium.ttf" },
      { weight: 700, file: "NotoSans-Bold.ttf" },
    ],
  },
  {
    family: "Noto Sans JP",
    label: "Noto Sans JP",
    weights: [
      { weight: 400, file: "NotoSansJP-Regular.ttf" },
      { weight: 500, file: "NotoSansJP-Medium.ttf" },
      { weight: 700, file: "NotoSansJP-Bold.ttf" },
    ],
  },
  {
    family: "Roboto",
    label: "Roboto",
    weights: [{ weight: 400, file: "Roboto-Variable.ttf" }],
  },
  {
    family: "Tinos",
    label: "Tinos (Times 互換)",
    weights: [
      { weight: 400, file: "Tinos-Regular.ttf" },
      { weight: 700, file: "Tinos-Bold.ttf" },
    ],
  },
  {
    family: "Cousine",
    label: "Cousine (Courier 互換)",
    weights: [
      { weight: 400, file: "Cousine-Regular.ttf" },
      { weight: 700, file: "Cousine-Bold.ttf" },
    ],
  },
  {
    family: "Anton",
    label: "Anton (Impact 風)",
    weights: [{ weight: 400, file: "Anton-Regular.ttf" }],
  },
  {
    family: "Dancing Script",
    label: "Dancing Script (Cursive 風)",
    weights: [{ weight: 400, file: "DancingScript-Variable.ttf" }],
  },
];

/** zip / public 上のフォントディレクトリ名。 */
export const BUILTIN_FONT_DIR = "fonts";

export function findBuiltinFontByFamily(family: string): BuiltinFontDef | undefined {
  return BUILTIN_FONTS.find((f) => f.family === family);
}

/** weight に最も近い同梱ウェイトを返す（400/500/700 のいずれか）。 */
export function nearestBuiltinWeight(def: BuiltinFontDef, weight: number): BuiltinFontWeight {
  let best = def.weights[0]!;
  for (const w of def.weights) {
    if (Math.abs(w.weight - weight) < Math.abs(best.weight - weight)) best = w;
  }
  return best;
}

/** `font` 文字列が built-in family を指すか（スタック先頭が built-in family なら true）。 */
export function isBuiltinFontFamily(font: string): boolean {
  return BUILTIN_FONTS.some((f) => fontUsesFamily(font, f.family));
}

/** family がスタック（例: `'Noto Sans', sans-serif`）の先頭に現れるか。 */
export function fontUsesFamily(font: string, family: string): boolean {
  return primaryFontFamily(font) === family;
}

/** CSS font スタックの先頭 family を bare 名で返す（'Noto Sans', sans-serif → Noto Sans）。 */
export function primaryFontFamily(font: string): string {
  return font.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "") ?? font;
}

const STYLE_EL_ID = "mafter-builtin-fonts";

/**
 * built-in フォントの @font-face を document に注入する（冪等）。
 * baseUrl は font ファイルが置かれた基底（エディタは "/fonts"、bundle は相対）。
 */
export function registerBuiltinFonts(baseUrl = "/fonts"): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_EL_ID)) return;
  const base = baseUrl.replace(/\/?$/, "");
  const css = BUILTIN_FONTS.flatMap((f) =>
    f.weights.map(
      (w) =>
        `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${w.weight};` +
        `font-display:swap;src:url('${base}/${w.file}') format('truetype');}`,
    ),
  ).join("\n");
  const style = document.createElement("style");
  style.id = STYLE_EL_ID;
  style.textContent = css;
  document.head.appendChild(style);
}
