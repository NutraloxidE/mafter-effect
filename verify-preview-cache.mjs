import { chromium } from "playwright";

// §28.9: Caching は既定 OFF。この検証は
//  (A) 既定 OFF で軽量 comp を再生 → バッジ「Cache OFF」（旧版は誤って「Realtime」を期待していた）
//  (B) previewBakeRequired な重い effect（pixelSorter）を含む comp を実 Play ボタンで再生
//      → activateAutoCacheIfNeeded 経由で Auto Cache セッションが自動起動（バッジ「Auto Cache」）
//  (C) Caching チェックボックスを実 DOM クリックで手動 ON → RAM/Clear UI 出現・スクラブでキャッシュ生成
//  (D) ワークエリア B/N + タイムライン緑バー
// を実機で確認する。§28 の RAM ではなく「実際に画面に出ている UI 文言」を張り替えの都度検証すること。
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
  const out = {};

  const badgeText = () => {
    const el = [...document.querySelectorAll("span")].find((s) =>
      /Cache OFF|Realtime|Auto Cache|Caching \d|Cached/.test(s.textContent ?? ""),
    );
    return el?.textContent ?? "(none)";
  };
  const cachingCheckbox = () => {
    const label = [...document.querySelectorAll("label")].find((l) => l.textContent?.trim() === "Caching");
    return label?.querySelector('input[type="checkbox"]') ?? null;
  };
  const playButton = () => document.querySelector('button[title="再生/停止"]');

  // (A) 既定 OFF — 軽量 solid を数フレーム進めてもキャッシュ UI は Cache OFF のまま。
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
  await new Promise((r) => setTimeout(r, 500));
  out.defaultCacheCheckboxChecked = cachingCheckbox()?.checked ?? null;
  out.badgeDefault = badgeText();
  out.defaultIsCacheOff = out.badgeDefault.includes("Cache OFF");

  // (B) previewBakeRequired effect（pixelSorter）を持つ重い comp を実 Play ボタンで再生
  //     → handleTogglePlay 経由で activateAutoCacheIfNeeded が起動するはず（S().setPlaying 直呼びでは起動しない）。
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
      props: { ...fx.props, thresholdLow: sp(0.1), thresholdHigh: sp(0.9), angle: sp(45) },
    }],
  }, "setup");
  await new Promise((r) => setTimeout(r, 200));

  S().setFrame(0);
  playButton()?.click();
  await new Promise((r) => setTimeout(r, 1500));
  out.badgeDuringAutoCache = badgeText();
  out.autoCacheTriggered = out.badgeDuringAutoCache.includes("Auto Cache");
  playButton()?.click(); // stop
  await new Promise((r) => setTimeout(r, 200));

  // (C) 明示的に Caching チェックボックスを実クリックで ON → RAM/Clear UI 出現 + スクラブでキャッシュ生成。
  // 直前の Auto Cache セッションでチェックボックスが既に checked=true（autoCacheSession 由来）の
  // ことがあるため、まず OFF に倒してから改めて ON にする（patchCacheSettings は enabled:false で
  // autoCacheSession も道連れにリセットする設計＝「OFF は全部を止める」）。
  let cb = cachingCheckbox();
  out.hadCheckbox = !!cb;
  if (cb?.checked) {
    cb.click();
    await new Promise((r) => setTimeout(r, 200));
  }
  cb = cachingCheckbox();
  cb?.click();
  await new Promise((r) => setTimeout(r, 200));
  out.manualCacheEnabled = cachingCheckbox()?.checked ?? false;
  const t2 = document.body.innerText;
  out.hasClearButton = t2.includes("Clear");
  out.hasRamInput = t2.includes("RAM");

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
const ok =
  report.defaultIsCacheOff &&
  report.autoCacheTriggered &&
  report.hadCheckbox &&
  report.manualCacheEnabled &&
  report.hasClearButton &&
  report.scrubCachedFrames > 0 &&
  report.workAreaOk &&
  errors.length === 0;
if (!ok) {
  console.error("FAIL", report);
  process.exitCode = 1;
} else {
  console.log("PASS");
}
await browser.close();
