// 実機検証: Export Quality ドロップダウンが Preview Quality と独立していること
// (a) Export Quality を変更しても footageQuality（preview）prop は変わらない
// (b) Export Quality を変更しても現在のプレビュー再生 <video> の src は変わらない
// (c) packedExportQuality prop が正しく書き込まれる
import { chromium } from "playwright";
import path from "node:path";

const PORT = process.env.VERIFY_PORT ?? "5173";
const APP_URL = `https://localhost:${PORT}/`;
const LEAN_DIR =
  "C:/Users/resis/AppData/Local/Temp/claude/c--Workspace-mafter-effect/1eeddf04-70a7-4e59-bdaa-3026ed2331ea/scratchpad";
const PROJECT_JSON_PATH = path.join(LEAN_DIR, "pj22", "project.json");
const VIDEO_MP4_PATH = path.join(LEAN_DIR, "pj22-lean", "01KWR47Y1AJ3GNX9Q7XK7KT8K7.mp4");
const PACKED_WEBM_PATH = path.join(LEAN_DIR, "pj22-lean", "01KWYFTPG6730SSPJXD2RAPVAM.webm");

const COMP32_ID = "01KWSRT0CQGZKJ0FNKEAD41F7M";
const PACKED_OBJ_ID = "01KWSS67VPCYTP5XKWPN1BP0EP";

const browser = await chromium.launch({
  headless: true,
  args: ["--ignore-certificate-errors", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true });
page.setDefaultTimeout(60000);
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));

await page.route("**/__fixture_project.json", (route) => route.fulfill({ path: PROJECT_JSON_PATH }));
await page.route("**/__fixture_video.mp4", (route) => route.fulfill({ path: VIDEO_MP4_PATH }));
await page.route("**/__fixture_packed.webm", (route) => route.fulfill({ path: PACKED_WEBM_PATH }));

await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate(() => indexedDB.deleteDatabase("mafter-effect-fs"));
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => window.__mafterEditorStore?.getState().getFs, { timeout: 20000 });

await page.evaluate(async () => {
  const st = window.__mafterEditorStore.getState();
  const fsInst = st.getFs();
  const [projectText, mp4Buf, webmBuf] = await Promise.all([
    fetch("/__fixture_project.json").then((r) => r.text()),
    fetch("/__fixture_video.mp4").then((r) => r.arrayBuffer()),
    fetch("/__fixture_packed.webm").then((r) => r.arrayBuffer()),
  ]);
  await fsInst.write("project.json", projectText);
  await fsInst.write("assets/01KWR47Y1AJ3GNX9Q7XK7KT8K7.mp4", new Uint8Array(mp4Buf));
  await fsInst.write("assets/01KWYFTPG6730SSPJXD2RAPVAM.webm", new Uint8Array(webmBuf));
  await window.__mafterEditorStore.getState().loadFromFs();
});

await page.evaluate((compId) => {
  const st = window.__mafterEditorStore.getState();
  st.setCurrentComp(compId);
  st.setFrame(0);
}, COMP32_ID);

await page.waitForFunction(
  (objId) => !!document.querySelector(`[data-object-id="${objId}"]`),
  PACKED_OBJ_ID,
  { timeout: 15000 },
);

await page.evaluate((objId) => {
  window.__mafterEditorStore.getState().setSelection?.([objId]) ??
    window.__mafterEditorStore.setState({ selectedObjectIds: [objId] });
}, PACKED_OBJ_ID);
await page.waitForTimeout(500);

const srcBefore = await page.evaluate((objId) => {
  const el = document.querySelector(`[data-object-id="${objId}"] video`);
  return el ? el.getAttribute("src") : null;
}, PACKED_OBJ_ID);
const propsBefore = await page.evaluate((objId) => {
  const st = window.__mafterEditorStore.getState();
  const obj = st.project?.compositions.flatMap((c) => (c.kind === "timeline" ? c.objects : [])).find((o) => o.id === objId);
  const vc = obj?.components.find((c) => c.type === "video");
  return { footageQuality: vc?.props?.footageQuality ?? null, packedExportQuality: vc?.props?.packedExportQuality ?? null };
}, PACKED_OBJ_ID);
console.log("before:", JSON.stringify({ srcBefore, propsBefore }));

// Find the Export Quality select specifically (second quality-like select, or by preceding label text).
const changed = await page.evaluate(() => {
  const labels = [...document.querySelectorAll("label")];
  const exportLabel = labels.find((l) => l.textContent?.trim() === "Export Quality");
  if (!exportLabel) return { ok: false, reason: "Export Quality label not found" };
  const container = exportLabel.parentElement;
  const sel = container?.querySelector("select");
  if (!sel) return { ok: false, reason: "select not found near label" };
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
  nativeSetter.call(sel, "medium");
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
});
console.log("Export Quality change:", JSON.stringify(changed));
await page.waitForTimeout(1500);

const srcAfter = await page.evaluate((objId) => {
  const el = document.querySelector(`[data-object-id="${objId}"] video`);
  return el ? el.getAttribute("src") : null;
}, PACKED_OBJ_ID);
const propsAfter = await page.evaluate((objId) => {
  const st = window.__mafterEditorStore.getState();
  const obj = st.project?.compositions.flatMap((c) => (c.kind === "timeline" ? c.objects : [])).find((o) => o.id === objId);
  const vc = obj?.components.find((c) => c.type === "video");
  return { footageQuality: vc?.props?.footageQuality ?? null, packedExportQuality: vc?.props?.packedExportQuality ?? null };
}, PACKED_OBJ_ID);
console.log("after:", JSON.stringify({ srcAfter, propsAfter }));

console.log("RESULT: preview src unchanged =", srcBefore === srcAfter);
console.log("RESULT: footageQuality (preview) unchanged =", propsBefore.footageQuality === propsAfter.footageQuality);
console.log("RESULT: packedExportQuality now 'medium' =", propsAfter.packedExportQuality === "medium");

await browser.close();
