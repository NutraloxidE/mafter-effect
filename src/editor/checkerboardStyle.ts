import type { CSSProperties } from "react";

/** §25.2 透明チェッカーボード（comp 背景未設定時の stage / スウォッチ表示）。 */
export const CHECKERBOARD_STYLE: CSSProperties = {
  backgroundColor: "#2a2a2a",
  backgroundImage:
    "linear-gradient(45deg, #333 25%, transparent 25%, transparent 75%, #333 75%), " +
    "linear-gradient(45deg, #333 25%, transparent 25%, transparent 75%, #333 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 8px 8px",
};
