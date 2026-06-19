import { chromium } from "playwright";

const PORT = process.env.VERIFY_PORT ?? "5173";
const URL = `http://localhost:${PORT}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(async () => {
  indexedDB.deleteDatabase("mafter-effect-fs");
  indexedDB.deleteDatabase("mafter-effect-preview-cache");
  localStorage.clear();
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

const report = await page.evaluate(async () => {
  const store = (await import("/src/editor/store.ts")).useEditorStore;
  const S = () => store.getState();
  for (let i = 0; i < 60 && !(S().project && S().currentCompId); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!S().project) S().newProject();
  await new Promise((r) => setTimeout(r, 300));

  const sp = (v) => ({ value: v, keyframes: [] });
  const v3 = (x, y) => ({ x, y, z: 0 });
  const out = { realtime: false, caching: false, cachedPlayback: false };

  const solidId = S().addSolid("Solid");
  const comp = S().project.compositions.find((k) => k.kind === "timeline");
  const obj = comp.objects.find((o) => o.id === solidId);
  S().updateObject(solidId, {
    transform: { ...obj.transform, position: sp(v3(960, 540)) },
    components: obj.components.map((c) =>
      c.type === "solid"
        ? { ...c, props: { ...c.props, color: sp({ r: 0.2, g: 0.6, b: 1, a: 1 }), size: sp(v3(400, 300)) } }
        : c,
    ),
  }, "setup");

  for (let f = 0; f < 8; f++) {
    S().setFrame(f);
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 1000));
  out.realtime = document.body.innerText.includes("Realtime");

  const heavyId = S().addSolid("Heavy");
  const fxId = S().addEffect(heavyId, "pixelSorter");
  const comp2 = S().project.compositions.find((k) => k.kind === "timeline");
  const heavy = comp2.objects.find((o) => o.id === heavyId);
  const fx = heavy.effects.find((e) => e.id === fxId);
  S().updateObject(heavyId, {
    transform: { ...heavy.transform, position: sp(v3(200, 200)) },
    components: heavy.components.map((c) =>
      c.type === "solid"
        ? { ...c, props: { ...c.props, color: sp({ r: 1, g: 0.3, b: 0.2, a: 1 }), size: sp(v3(300, 200)) } }
        : c,
    ),
    effects: [{
      ...fx,
      props: {
        ...fx.props,
        thresholdLow: sp(0.1),
        thresholdHigh: sp(0.9),
        angle: sp(45),
      },
    }],
  }, "setup");

  for (let f = 0; f < 6; f++) {
    S().setFrame(f);
    await new Promise((r) => setTimeout(r, 200));
  }
  const { previewCacheService } = await import("/src/editor/previewCacheService.ts");
  let scrubCached = 0;
  for (let i = 0; i < 40; i++) {
    scrubCached = (await previewCacheService.listCachedFrames()).size;
    if (scrubCached > 0) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  out.scrubCachedFrames = scrubCached;
  const t2 = document.body.innerText;
  out.caching = t2.includes("Caching") || t2.includes("Cached");

  S().setPlaying(true);
  await new Promise((r) => setTimeout(r, 3000));
  S().setPlaying(false);
  const t3 = document.body.innerText;
  out.cachedPlayback = t3.includes("Cached") || t3.includes("Realtime");

  // §28.8 ワークエリア B/N + 緑バー
  const { loadWorkArea } = await import("/src/editor/workAreaStorage.ts");
  S().setFrame(5);
  S().setWorkAreaIn();
  S().setFrame(15);
  S().setWorkAreaOut();
  await new Promise((r) => setTimeout(r, 200));
  const wa = loadWorkArea(comp2.id, comp2.duration);
  out.workArea = wa;
  out.workAreaOk = wa.inPoint === 5 && wa.outPoint === 16;

  const greenBars = [...document.querySelectorAll("div")].filter((el) => {
    const bg = el.style.background;
    return bg === "#3a8f3a" || bg === "rgb(58, 143, 58)";
  });
  out.cacheBarCount = greenBars.length;

  return out;
});

console.log("VERIFY_PREVIEW_CACHE", JSON.stringify(report, null, 2));
if (errors.length) console.error("CONSOLE_ERRORS", errors);
const ok = report.realtime && (report.caching || report.cachedPlayback) && report.workAreaOk && report.scrubCachedFrames > 0;
if (!ok) {
  console.error("FAIL", report);
  process.exitCode = 1;
}
await browser.close();
