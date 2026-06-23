import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { registerBuiltinFonts } from "./runtime/builtinFonts";

// §26.3.2 同梱フォント（Noto Sans / Noto Sans JP）を登録。preview と
// 同一 document で走る WebCodecs/PNG export 双方をこの 1 回でカバーする。
registerBuiltinFonts("/fonts");

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
