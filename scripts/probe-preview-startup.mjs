// Phase 0 計測ハーネス（doc/issue/preview-rendering-pipeline-optimization-plan.md）。
// 起動時の LCP / Long task / loadFromProject 時間 / 初期プレビュー描画までの wall time を
// 実ブラウザ（Playwright + Chromium）で計測し、report に before/after を追記する。
//
// 使い方:
//   node scripts/probe-preview-startup.mjs [--label=phase0-baseline] [--runs=3]
//   VERIFY_PORT=5175 node scripts/probe-preview-startup.mjs
//   VERIFY_HTTPS=1 VERIFY_PORT=5175 node scripts/probe-preview-startup.mjs   (Phase 1 以降 basic-ssl 有効時)
//
// 固定テストプロジェクト: for-debug-data/_pj17（動画5本+画像2枚, 27 comps の実プロジェクト展開済みフォルダ）。
// 注: for-debug-data/mafter-project (11).zip はこの環境では 0 byte（未転送のプレースホルダ）のため使えず、
// 代わりに同種の実データが残っている展開済みフォルダを使う。zip import ではなく、Vite dev server の
// `/@fs/<absolute path>` 経由でファイルを直接 fetch → IndexedDbFs に write する（巨大バイナリを
// Playwright evaluate 引数として渡すとシリアライズが重いため）。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5175";
const USE_HTTPS = process.env.VERIFY_HTTPS === "1";
const PROTO = USE_HTTPS ? "https" : "http";
const URL = `${PROTO}://localhost:${PORT}/`;
const FIXTURE_DIR = "for-debug-data/_pj17";
const FIXTURE_ABS = path.resolve(FIXTURE_DIR).replace(/\\/g, "/");
// bundle export の副産物（この展開フォルダに同居しているだけで live FS の一部ではない）は除外。
const FIXTURE_SKIP_TOP_LEVEL = new Set(["bundle-manifest.json", "index.html", "player.js"]);
const REPORT_PATH = "probe-preview-startup-report.md";

/** FIXTURE_DIR 配下の全ファイルを相対パス（"/" 区切り）で再帰列挙する。 */
function listFixtureFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).replace(/\\/g, "/");
    if (path.dirname(rel) === "." && FIXTURE_SKIP_TOP_LEVEL.has(rel)) continue;
    if (entry.isDirectory()) listFixtureFiles(abs, base, out);
    else out.push(rel);
  }
  return out;
}

const args = process.argv.slice(2);
const label = args.find((a) => a.startsWith("--label="))?.split("=")[1] ?? "run";
const runs = Number(args.find((a) => a.startsWith("--runs="))?.split("=")[1] ?? "3");

console.log(`probe-preview-startup: starting… (${URL}, label=${label}, runs=${runs})`);

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

// PerformanceObserver は各ナビゲーションごとに再インストールが必要（addInitScript は毎回実行される）。
await page.addInitScript(() => {
  window.__mafterProbe = { longTasks: [], lcp: null };
  try {
    const lo = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__mafterProbe.longTasks.push({ start: e.startTime, duration: e.duration });
      }
    });
    lo.observe({ type: "longtask", buffered: true });
  } catch {
    /* longtask 非対応環境（無視） */
  }
  try {
    const po = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) window.__mafterProbe.lcp = last.startTime;
    });
    po.observe({ type: "largest-contentful-paint", buffered: true });
  } catch {
    /* LCP 非対応環境（無視） */
  }
});

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => {
  const s = window.__mafterEditorStore;
  return s && s.getState().project && s.getState().currentCompId;
}, { timeout: 20000 });

// 固定テストプロジェクトを一度だけ FS 直書きで定着させる（/@fs/ 経由の in-browser fetch、Node→ブラウザ引数渡しを回避）。
// project.json だけでなく assets/*・scripts/*（expression 脚本）・presets/* も丸ごと write する
// （scripts 欠落だと ExpressionEngine.prepare() が読み込み失敗し、renderTick が永久に発火しない）。
const fixtureFiles = listFixtureFiles(FIXTURE_DIR);
console.log(`fixture files to mirror: ${fixtureFiles.length}`);

const importInfo = await page.evaluate(async ({ fixtureAbs, relPaths }) => {
  const store = window.__mafterEditorStore;
  const S = () => store.getState();
  const fsInst = S().getFs();
  async function fetchBytes(relPath) {
    const url = `/@fs/${fixtureAbs}/${relPath}`.split(" ").join("%20");
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fixture fetch failed ${resp.status} ${url}`);
    return new Uint8Array(await resp.arrayBuffer());
  }
  for (const relPath of relPaths) {
    const bytes = await fetchBytes(relPath);
    await fsInst.write(relPath, bytes);
  }
  await S().loadFromFs();
  const loaded = S().project;
  const assetCounts = { image: 0, video: 0, other: 0 };
  for (const a of loaded.assets) {
    if (a.kind === "image") assetCounts.image++;
    else if (a.kind === "video") assetCounts.video++;
    else assetCounts.other++;
  }
  return { compCount: loaded.compositions.length, assetCounts };
}, { fixtureAbs: FIXTURE_ABS, relPaths: fixtureFiles });

console.log("fixture imported:", importInfo);
if (importInfo.assetCounts.video === 0 && importInfo.assetCounts.image === 0) {
  console.error("FAIL: fixture project has no image/video assets — probe would not exercise the target code path");
  await browser.close();
  process.exit(1);
}

// 「プロジェクトロード開始 → 最初のプレビュー描画」を、既存アセットが入った状態での
// フル再読込（実際の「アプリを開き直す」体験）として複数回計測する。
const samples = [];
for (let i = 0; i < runs; i++) {
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  // 「最初のプレビュー描画」の代理指標: PreviewPanel が最初に renderFrame を呼んだ瞬間の
  // performance.mark("mafter:firstPreviewRender")。scene 内容（frame 0 に可視オブジェクトが
  // あるか）に依存しない（inPoint > 0 のオブジェクトのみの comp でも安定して検出できる）。
  await page.waitForFunction(() => {
    const s = window.__mafterEditorStore;
    if (!s || !(s.getState().project && s.getState().currentCompId)) return false;
    return performance.getEntriesByName("mafter:firstPreviewRender", "mark").length > 0;
  }, { timeout: 30000 });
  const firstRenderMs = await page.evaluate(() => {
    const marks = performance.getEntriesByName("mafter:firstPreviewRender", "mark");
    return marks[0].startTime;
  });
  // Long task / LCP / loadFromProject measure entries が出揃うまで少し待つ。
  await page.waitForTimeout(1500);
  const metrics = await page.evaluate(() => {
    const probe = window.__mafterProbe ?? { longTasks: [], lcp: null };
    const longTasks = probe.longTasks;
    const maxLongTaskMs = longTasks.reduce((m, t) => Math.max(m, t.duration), 0);
    const totalLongTaskMs = longTasks.reduce((a, t) => a + t.duration, 0);
    const loadMeasures = performance.getEntriesByName("mafter:loadFromProject", "measure");
    const loadFromProjectMs = loadMeasures.length ? loadMeasures[loadMeasures.length - 1].duration : null;
    return {
      longTaskCount: longTasks.length,
      maxLongTaskMs: Math.round(maxLongTaskMs),
      totalLongTaskMs: Math.round(totalLongTaskMs),
      lcpMs: probe.lcp != null ? Math.round(probe.lcp) : null,
      loadFromProjectMs: loadFromProjectMs != null ? Math.round(loadFromProjectMs) : null,
    };
  });
  samples.push({ run: i + 1, firstRenderMs: Math.round(firstRenderMs), ...metrics });
}

function median(nums) {
  const xs = nums.filter((n) => n != null).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

const summary = {
  firstRenderMs: median(samples.map((s) => s.firstRenderMs)),
  maxLongTaskMs: median(samples.map((s) => s.maxLongTaskMs)),
  totalLongTaskMs: median(samples.map((s) => s.totalLongTaskMs)),
  longTaskCount: median(samples.map((s) => s.longTaskCount)),
  lcpMs: median(samples.map((s) => s.lcpMs)),
  loadFromProjectMs: median(samples.map((s) => s.loadFromProjectMs)),
};

console.log("samples:", JSON.stringify(samples, null, 2));
console.log("median:", JSON.stringify(summary, null, 2));

if (errors.length > 0) {
  console.error("console errors observed:", errors);
}

const now = new Date().toISOString();
const row = `| ${now} | ${label} | ${summary.firstRenderMs} | ${summary.lcpMs} | ${summary.maxLongTaskMs} | ${summary.totalLongTaskMs} | ${summary.longTaskCount} | ${summary.loadFromProjectMs} |\n`;
const header = `| timestamp | label | firstRenderMs(median) | lcpMs(median) | maxLongTaskMs(median) | totalLongTaskMs(median) | longTaskCount(median) | loadFromProjectMs(median) |\n|---|---|---|---|---|---|---|---|\n`;

if (!fs.existsSync(REPORT_PATH)) {
  fs.writeFileSync(
    REPORT_PATH,
    `# Preview Startup Probe Report\n\n` +
      `Phase 0 計測ハーネス（scripts/probe-preview-startup.mjs）の実測値。\n` +
      `固定テストプロジェクト: for-debug-data/_pj17（動画5本+画像1枚, 27 comps の実プロジェクト展開済みフォルダ）。\n\n` +
      header +
      row,
  );
} else {
  fs.appendFileSync(REPORT_PATH, row);
}
console.log(`report appended: ${REPORT_PATH}`);

await browser.close();
console.log(errors.length > 0 ? "DONE (with console errors — see above)" : "DONE");
process.exit(0);
