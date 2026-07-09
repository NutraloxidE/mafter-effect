// UI 検証: packed alpha レイヤーの Inspector に PackedPreviewQualitySelect が表示され、
// 通常の Quality ドロップダウンが出ないこと・選択で ensureProxyTier が発火することを確認する。
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

// select the packed layer in the store so Inspector shows it.
await page.evaluate((objId) => {
  window.__mafterEditorStore.getState().setSelection?.([objId]) ??
    window.__mafterEditorStore.setState({ selectedObjectIds: [objId] });
}, PACKED_OBJ_ID);
await page.waitForTimeout(500);

// Expand the "Video" component foldout if collapsed — click any foldout header containing "Video".
const foldoutClicked = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("button")];
  const btn = buttons.find((b) => b.textContent?.trim().startsWith("Video") || b.textContent?.includes("▶ Video") || b.textContent?.includes("▼ Video"));
  if (btn) { btn.click(); return true; }
  return false;
});
console.log("video foldout button clicked:", foldoutClicked);
await page.waitForTimeout(300);

const domCheck = await page.evaluate(() => {
  const body = document.body.innerText;
  return {
    hasPreviewQualityLabel: body.includes("Preview Quality"),
    hasNote: body.includes("mp4 / webm / PNG"),
    hasGenericQualityLabel: body.includes("Quality") && !body.includes("Preview Quality") ? true : /(?<!Preview )Quality/.test(body),
  };
});
console.log("DOM check:", JSON.stringify(domCheck, null, 2));

// Find the select whose options include "Original"/"High"/etc (footageQualityLabel values) inside inspector.
const selectInfo = await page.evaluate(() => {
  const selects = [...document.querySelectorAll("select")];
  const candidates = selects.filter((s) => [...s.querySelectorAll("option")].some((o) => o.textContent === "Original"));
  return candidates.map((s) => ({
    optionCount: s.querySelectorAll("option").length,
    value: s.value,
    outerHTMLSnippet: s.outerHTML.slice(0, 200),
  }));
});
console.log("quality-like selects found:", JSON.stringify(selectInfo, null, 2));

// Change the dropdown to "medium" and confirm it triggers busy state + ensureProxyTier.
await page.evaluate(() => {
  const selects = [...document.querySelectorAll("select")];
  const sel = selects.find((s) => [...s.querySelectorAll("option")].some((o) => o.textContent === "Original"));
  if (!sel) throw new Error("select not found");
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
  nativeSetter.call(sel, "medium");
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(400);
const busyState = await page.evaluate(() => document.body.innerText.includes("generating…"));
console.log("busy indicator visible after selecting 'medium':", busyState);

const propAfter = await page.evaluate((objId) => {
  const st = window.__mafterEditorStore.getState();
  const obj = st.project?.compositions
    .flatMap((c) => (c.kind === "timeline" ? c.objects : []))
    .find((o) => o.id === objId);
  const vc = obj?.components.find((c) => c.type === "video");
  return vc?.props?.footageQuality ?? null;
}, PACKED_OBJ_ID);
console.log("footageQuality prop after selection:", propAfter);

await browser.close();
