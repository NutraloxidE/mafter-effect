import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8")) as { version: string };

// Phase 1（preview-rendering-pipeline-optimization-plan §Phase1）: dev サーバを HTTP/2 化し、
// HTTP/1.1 の 6 接続上限による 200+ JS モジュールの直列ロードを解消する。
// Electron dev（electron:dev）は wait-on / ELECTRON_RENDERER_URL が http:// 固定のため https 化しない。
// MAFTER_DEV_HTTP1=1: ローカル feedback 検証用の逃げ道（doc/feedback-loop.md G3）。Vite は
// server.https が真でも server.proxy が設定されていると内部で https.createServer（HTTP/1.1）に
// フォールバックし http2.createSecureServer を使わない（node_modules/vite の resolveHttpServer 参照）。
// そのため https 有効時は /api/feedback proxy を外して実際に HTTP/2 が使われるようにする。
const forceHttp1 = process.env.MAFTER_DEV_HTTP1 === "1";
const enableHttps = !process.env.ELECTRON_DEV_PORT && !process.env.ELECTRON_FILE && !forceHttp1;

export default defineConfig({
  plugins: [react(), ...(enableHttps ? [basicSsl()] : [])],
  // Electron の file:// 起動（electron:start）は絶対パス "/assets/..." を解決できないため
  // 相対パスに切り替える。通常の web ビルド/デプロイでは ELECTRON_FILE 未設定 = "/" のまま。
  base: process.env.ELECTRON_FILE ? "./" : "/",
  // §Phase2b: package.json version をビルド時にクライアントへ注入（feedbackCollector の appVersion）。
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: true,
    ...(enableHttps ? { https: true } : {}),
    // electron:dev は wait-on / ELECTRON_RENDERER_URL で固定ポートを直に参照するため、
    // ポートが使用中で自動繰り上げされると Electron が古い/別のサーバに繋がる。strictPort で早期に失敗させる。
    ...(process.env.ELECTRON_DEV_PORT
      ? { port: Number(process.env.ELECTRON_DEV_PORT), strictPort: true }
      : {}),
    // doc/feedback-loop.md G3: ローカル検証時は `python scripts/mafter_http_server.py --port 5174` を別途起動。
    // 未起動でも他のリクエストには影響しない（このパスのみ ECONNREFUSED）。
    // https（HTTP/2）有効時は proxy を設定しない（上記 forceHttp1 コメント参照）。
    // フィードバック動作確認したいときは `MAFTER_DEV_HTTP1=1 npm run dev` で HTTP/1.1 に戻す。
    ...(enableHttps
      ? {}
      : {
          proxy: {
            "/api/feedback": {
              target: "http://127.0.0.1:5174",
              changeOrigin: true,
            },
          },
        }),
  },
  test: {
    globals: true,
    environment: "node",
  },
});
