// Vercel（静的ホスティング）配信の再現検証。
//
// Vercel のルーティング順（filesystem 優先 → 該当なしなら vercel.json の rewrites）を
// ローカルで再現し、`npm run build` の dist/ が静的配信だけで起動することを実ブラウザで確かめる。
// doc/deploy-vercel.md 参照。
//
// 使い方:
//   npm run build
//   node verify-vercel-static.mjs
// 環境変数:
//   MAFTER_CHROMIUM  playwright の同梱ブラウザを使わない場合の chrome 実行ファイルパス
//   MAFTER_VERIFY_PORT  検証用ポート（既定 4178）
import http from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(fileURLToPath(new URL("./", import.meta.url)));
const DIST = path.join(ROOT, "dist");
const PORT = Number(process.env.MAFTER_VERIFY_PORT ?? 4178);

if (!existsSync(path.join(DIST, "index.html"))) {
  console.error("dist/index.html がありません。先に `npm run build` を実行してください。");
  process.exit(1);
}

const vercelCfg = JSON.parse(readFileSync(path.join(ROOT, "vercel.json"), "utf-8"));
const rewriteRe = new RegExp(`^${vercelCfg.rewrites[0].source}$`);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff2": "font/woff2",
};

/** @type {{ path: string, status: number }[]} */
const requested = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  // パス走査（".." 混入）を弾いたうえで dist 配下に解決する。
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  let filePath = path.join(DIST, rel);
  let served =
    filePath.startsWith(DIST) && existsSync(filePath) && statSync(filePath).isFile();
  if (!served && (url.pathname === "/" || rewriteRe.test(url.pathname))) {
    filePath = path.join(DIST, "index.html");
    served = true;
  }
  requested.push({ path: url.pathname, status: served ? 200 : 404 });
  if (!served) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
  createReadStream(filePath).pipe(res);
});

await new Promise((resolve) => server.listen(PORT, resolve));
const base = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch(
  process.env.MAFTER_CHROMIUM
    ? { executablePath: process.env.MAFTER_CHROMIUM, args: ["--no-sandbox"] }
    : {},
);
const page = await browser.newPage();
/** @type {string[]} */ const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(`${base}/`, { waitUntil: "load" });
await page.waitForTimeout(6000);

// 1) エディタが起動する（React マウント + 主要パネル描画）
const booted = await page.evaluate(
  () =>
    (document.getElementById("root")?.children.length ?? 0) > 0 &&
    document.body.innerText.includes("Timeline"),
);

// 2) publicAssetUrl("fonts") が静的ホストで解決できる（@font-face 実ロード）
const fontProbe = await page.evaluate(async () => {
  const css = document.getElementById("mafter-builtin-fonts")?.textContent ?? "";
  const src = css.match(/src:url\('([^']+)'\)/);
  const fam = css.match(/font-family:'([^']+)'/);
  if (!src || !fam) return { ok: false, reason: "font-face 未注入" };
  await document.fonts.load(`400 16px '${fam[1]}'`);
  const res = await fetch(src[1]);
  return { ok: res.ok, url: src[1], status: res.status, bytes: (await res.arrayBuffer()).byteLength };
});

// 起動時に実際に飛んだリクエストの記録（以降の probe fetch は意図的に 404 を作るため対象外）
const bootRequests = requested.slice();

// 3) rewrite の副作用が無いこと
//    - 拡張子付きの実在しないアセットは 404 のまま（index.html を返さない）
//    - 拡張子なしパスだけ index.html にフォールバックする
//    - /api/* は rewrite 対象外（POST が index.html で 200 になってはいけない）
const routing = await page.evaluate(async (b) => {
  const missing = await fetch(`${b}/fonts/does-not-exist.ttf`);
  const deep = await fetch(`${b}/some/deep/route`);
  const api = await fetch(`${b}/api/feedback`, { method: "POST", body: "{}" });
  return {
    missingAsset: missing.status,
    spaFallback: { status: deep.status, isAppShell: (await deep.text()).includes('<div id="root">') },
    apiNotRewritten: api.status,
  };
}, base);

await page.screenshot({ path: path.join(ROOT, "verify-vercel-static.png") });
await browser.close();
server.close();

// favicon はプロジェクトに存在しない（ホスト非依存の 404）ため除外する。
const unexpected404 = bootRequests.filter((r) => r.status === 404 && r.path !== "/favicon.ico");
const checks = {
  booted,
  fontLoadable: fontProbe.ok === true,
  missingAssetStays404: routing.missingAsset === 404,
  spaFallbackServesAppShell: routing.spaFallback.status === 200 && routing.spaFallback.isAppShell,
  apiPathNotRewritten: routing.apiNotRewritten === 404,
  noUnexpected404: unexpected404.length === 0,
  noPageErrors: pageErrors.length === 0,
};
const failed = Object.entries(checks).filter(([, ok]) => !ok);

console.log(JSON.stringify({ checks, fontProbe, routing, unexpected404, pageErrors }, null, 2));
console.log(failed.length === 0 ? "PASS" : `FAIL: ${failed.map(([k]) => k).join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
