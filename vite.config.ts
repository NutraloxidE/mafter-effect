import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8")) as { version: string };

export default defineConfig({
  plugins: [react()],
  // Electron の file:// 起動（electron:start）は絶対パス "/assets/..." を解決できないため
  // 相対パスに切り替える。通常の web ビルド/デプロイでは ELECTRON_FILE 未設定 = "/" のまま。
  base: process.env.ELECTRON_FILE ? "./" : "/",
  // §Phase2b: package.json version をビルド時にクライアントへ注入（feedbackCollector の appVersion）。
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: true,
    // electron:dev は wait-on / ELECTRON_RENDERER_URL で固定ポートを直に参照するため、
    // ポートが使用中で自動繰り上げされると Electron が古い/別のサーバに繋がる。strictPort で早期に失敗させる。
    ...(process.env.ELECTRON_DEV_PORT
      ? { port: Number(process.env.ELECTRON_DEV_PORT), strictPort: true }
      : {}),
    // doc/feedback-loop.md G3: ローカル検証時は `python scripts/mafter_http_server.py --port 5174` を別途起動。
    // 未起動でも他のリクエストには影響しない（このパスのみ ECONNREFUSED）。
    proxy: {
      "/api/feedback": {
        target: "http://127.0.0.1:5174",
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: "node",
  },
});
