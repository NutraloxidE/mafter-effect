export type FormatScrubDisplayOpts = {
  maxDecimals?: number;
};

/** 末尾の不要なゼロと小数点を除去する。 */
export function trimTrailingZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

/**
 * ScrubNumber 等の表示用フォーマット。
 * 内部値は丸めず、見た目だけ適応桁数 + 末尾ゼロ除去する。
 */
export function formatScrubDisplay(v: number, opts?: FormatScrubDisplayOpts): string {
  if (!Number.isFinite(v)) return "0";
  if (v === 0) return "0";

  const maxDecimals = opts?.maxDecimals ?? 4;
  const abs = Math.abs(v);

  let decimals: number;
  if (abs >= 10) {
    decimals = 2;
  } else if (abs >= 1) {
    decimals = 2;
  } else if (abs >= 0.01) {
    decimals = 2;
  } else {
    const needed = Math.max(2, Math.ceil(-Math.log10(abs)) + 1);
    decimals = Math.min(needed, maxDecimals);
  }

  return trimTrailingZeros(v.toFixed(decimals));
}

/** 編集モード・ホバー用のフル精度表示。 */
export function formatScrubEdit(v: number): string {
  if (!Number.isFinite(v)) return "0";
  if (v === 0) return "0";
  return String(v);
}

/** title 用の高精度表示。 */
export function formatScrubTitle(v: number): string {
  return formatScrubEdit(v);
}
