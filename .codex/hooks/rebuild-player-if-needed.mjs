// PostToolUse hook: src/player・src/runtime（= bundle player が import する範囲）を
// Edit/Write したら public/player.js をバックグラウンド再ビルドする。
// 目的: export に埋め込む player.js の「再ビルド忘れ」で新機能が HTML 書き出しに出ない事故を防ぐ。
// 編集をブロックしないよう detached + unref で非同期実行（export 時のガードと鮮度テストが最終防御）。
import { spawn } from "node:child_process";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let filePath = "";
  try {
    const data = JSON.parse(input || "{}");
    filePath = String(data?.tool_input?.file_path ?? "").replace(/\\/g, "/");
  } catch {
    process.exit(0);
  }

  if (!/(^|\/)src\/(player|runtime)\//.test(filePath)) process.exit(0);

  // Windows で .cmd（npm）を detached spawn するには shell:true が必要（EINVAL 回避）。
  const child = spawn("npm", ["run", "build:player"], {
    detached: true,
    stdio: "ignore",
    shell: true,
  });
  child.unref();
  process.exit(0);
});
