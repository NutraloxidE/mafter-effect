// 実機検証: Preview Quality の「Same as Export Quality」が
// (a) ドロップダウンに表示される
// (b) 選択すると footageQuality prop に "same_as_export" が書き込まれる
// (c) Export Quality を変更すると、リンク中のプレビューが自動で追従する（<video src> が変わる）
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

// Find Preview Quality select, confirm "Same as Export Quality" option exists.
const optionCheck = await page.evaluate(() => {
  const labels = [...document.querySelectorAll("label")];
  const previewLabel = labels.find((l) => l.textContent?.trim() === "Preview Quality");
  const sel = previewLabel?.parentElement?.querySelector("select");
  if (!sel) return { found: false };
  const options = [...sel.querySelectorAll("option")].map((o) => ({ value: o.value, text: o.textContent }));
  return { found: true, options };
});
console.log("Preview Quality options:", JSON.stringify(optionCheck, null, 2));

// Select "Same as Export Quality".
await page.evaluate(() => {
  const labels = [...document.querySelectorAll("label")];
  const previewLabel = labels.find((l) => l.textContent?.trim() === "Preview Quality");
  const sel = previewLabel?.parentElement?.querySelector("select");
  if (!sel) throw new Error("Preview Quality select not found");
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
  nativeSetter.call(sel, "same_as_export");
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(500);

const propsAfterLink = await page.evaluate((objId) => {
  const st = window.__mafterEditorStore.getState();
  const obj = st.project?.compositions.flatMap((c) => (c.kind === "timeline" ? c.objects : [])).find((o) => o.id === objId);
  const vc = obj?.components.find((c) => c.type === "video");
  return { footageQuality: vc?.props?.footageQuality ?? null };
}, PACKED_OBJ_ID);
console.log("footageQuality after selecting Same as Export Quality:", JSON.stringify(propsAfterLink));

const resolvedHintVisible = await page.evaluate(() => document.body.innerText.includes("→ Original"));
console.log("resolved-tier hint shows '→ Original' (Export Quality default):", resolvedHintVisible);

const srcBeforeExportChange = await page.evaluate((objId) => {
  const el = document.querySelector(`[data-object-id="${objId}"] video`);
  return el ? el.getAttribute("src") : null;
}, PACKED_OBJ_ID);

// Now change Export Quality to "medium" — preview is linked (same_as_export), so this should
// trigger proxy generation AND (once it succeeds) a preview reload/follow. NOTE: headless Chromium
// is known to hang on WebCodecs VP9 encode completion (memory: headless-webcodecs-encode-blocks) —
// so we only confirm the generation was correctly *triggered* here (busy indicator), not that it
// finishes; the linking/reload logic itself is covered by real-browser-independent unit tests
// (test/footageQuality.test.ts's PACKED_SAME_AS_EXPORT suite) plus this probe's UI-wiring checks above.
await page.evaluate(() => {
  const labels = [...document.querySelectorAll("label")];
  const exportLabel = labels.find((l) => l.textContent?.trim() === "Export Quality");
  const sel = exportLabel?.parentElement?.querySelector("select");
  if (!sel) throw new Error("Export Quality select not found");
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
  nativeSetter.call(sel, "medium");
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(800);

const exportPropAfter = await page.evaluate((objId) => {
  const st = window.__mafterEditorStore.getState();
  const obj = st.project?.compositions.flatMap((c) => (c.kind === "timeline" ? c.objects : [])).find((o) => o.id === objId);
  const vc = obj?.components.find((c) => c.type === "video");
  return vc?.props?.packedExportQuality ?? null;
}, PACKED_OBJ_ID);
const busyVisible = await page.evaluate(() => document.body.innerText.includes("generating…"));
console.log("packedExportQuality prop committed to 'medium':", exportPropAfter === "medium");
console.log("busy indicator visible (generation triggered — completion is a known headless-only limitation):", busyVisible);
console.log({ srcBeforeExportChange });

await browser.close();
